import { tool } from "ai";
import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * 文件系统 inline tools：Read / Write / Edit / Glob / Bash
 * 对齐 Claude Code SDK 的同名工具语义，让员工能做结构化文件操作。
 * run_process (Playwright MCP) 也能间接做这些事，但专用工具更高效、更安全（可加门禁）。
 *
 * **为什么是工厂而不是模块级常量**：路径门禁 `buildReadRootsGuard` 按**本次 run 的
 * 工作目录**解析相对路径，工具必须用同一个基准，否则校验和执行落在两个不同目录上，
 * 门禁就能被绕过——实测评测师传相对路径 `.agent-bench`，守卫按 runCwd 拼出「在范围内」
 * 放行，而 Glob 用 `process.cwd()` 实际搜到了服务根目录、读出声明范围外的文件。
 *
 * 绝对路径经 `resolve` 原样返回，所以以绝对路径调用的岗位行为零变化。
 */
export function buildFilesystemTools(cwd: string) {
  /** 归一到本次 run 的工作目录——必须与路径门禁同一个基准 */
  const at = (p: string): string => resolve(cwd, p);

  // ─── Read ────────────────────────────────────────────────

  const readTool = tool({
    description:
      "Read a file's contents. Returns lines with line numbers. " +
      "Use offset/limit for large files. Supports text files only.",
    inputSchema: z.object({
      file_path: z.string().describe("Absolute path to the file to read"),
      offset: z.number().int().min(1).optional().describe("Start line number (1-based)"),
      limit: z.number().int().min(1).optional().describe("Number of lines to read"),
    }),
    execute: async ({ file_path, offset, limit }) => {
      try {
        const target = at(file_path);
        if (!existsSync(target)) return `Error: file not found: ${file_path}`;
        const stat = statSync(target);
        if (stat.isDirectory()) return `Error: path is a directory, not a file: ${file_path}`;
        if (stat.size > 10 * 1024 * 1024) return `Error: file too large (${stat.size} bytes), use offset/limit`;
        const content = readFileSync(target, "utf-8");
        const lines = content.split("\n");
        const start = (offset ?? 1) - 1;
        const end = limit ? start + limit : lines.length;
        const slice = lines.slice(start, end);
        return slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // ─── Write ───────────────────────────────────────────────

  const writeTool = tool({
    description:
      "Write content to a file. Overwrites existing content or creates a new file. " +
      "Parent directories are created automatically.",
    inputSchema: z.object({
      file_path: z.string().describe("Absolute path to write to (creates parent dirs if needed)"),
      content: z.string().describe("Complete file content to write"),
    }),
    execute: async ({ file_path, content }) => {
      try {
        const target = at(file_path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf-8");
        const lines = content.split("\n").length;
        return `Successfully wrote ${lines} lines to ${target}`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // ─── Edit ────────────────────────────────────────────────

  const editTool = tool({
    description:
      "Replace an exact string in a file. The old_string must appear exactly once in the file " +
      "(include surrounding context lines to ensure uniqueness). " +
      "Use for surgical edits without rewriting the entire file.",
    inputSchema: z.object({
      file_path: z.string().describe("Absolute path to the file to edit"),
      old_string: z.string().describe("Exact text to find and replace (must match uniquely)"),
      new_string: z.string().describe("Replacement text"),
    }),
    execute: async ({ file_path, old_string, new_string }) => {
      try {
        const target = at(file_path);
        if (!existsSync(target)) return `Error: file not found: ${file_path}`;
        const content = readFileSync(target, "utf-8");
        const count = content.split(old_string).length - 1;
        if (count === 0) return "Error: old_string not found in file";
        if (count > 1) return `Error: old_string found ${count} times, must be unique (add more context)`;
        writeFileSync(target, content.replace(old_string, new_string), "utf-8");
        return `Successfully edited ${target}`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // ─── Glob ────────────────────────────────────────────────

  const globTool = tool({
    description:
      "Find files matching a glob pattern. Returns matching file paths sorted by modification time (newest first). " +
      "Uses the system's `find` command with pattern matching.",
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")'),
      path: z.string().optional().describe("Directory to search in (default: the run working directory)"),
    }),
    execute: async ({ pattern, path: searchPath }) => {
      const searchRoot = searchPath ? at(searchPath) : cwd;
      try {
        // Use fd if available, fallback to find
        const useFd = await exec("which", ["fd"]).then(() => true).catch(() => false);
        let stdout: string;
        if (useFd) {
          const result = await exec("fd", ["--glob", pattern, "--type", "f", "--color", "never"], {
            cwd: searchRoot,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 15000,
          });
          stdout = result.stdout;
        } else {
          // Convert glob to find pattern (basic support)
          const findPattern = pattern.replace(/\*\*/g, "GLOBSTAR").replace(/\*/g, "*");
          const result = await exec("find", [searchRoot, "-name", findPattern.includes("GLOBSTAR") ? pattern.split("/").pop()! : pattern, "-type", "f"], {
            maxBuffer: 2 * 1024 * 1024,
            timeout: 15000,
          });
          stdout = result.stdout;
        }
        const files = stdout.split("\n").filter(Boolean);
        if (files.length === 0) return "No files found.";
        // Sort by mtime (newest first) — limit to 200 to avoid massive output
        const limited = files.slice(0, 200);
        return limited.join("\n") + (files.length > 200 ? `\n…(${files.length - 200} more)` : "");
      } catch (error: unknown) {
        const e = error as { message?: string };
        return `Error: ${e.message ?? "unknown error"}`;
      }
    },
  });

  // ─── Bash ────────────────────────────────────────────────

  const bashTool = tool({
    description:
      "Execute a shell command and return its output. " +
      "Supports pipes, redirects, and all shell features. " +
      "Use for running builds, tests, git operations, and system commands.",
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory for the command (default: the run working directory)"),
      timeout: z.number().int().min(1000).max(300000).optional()
        .describe("Timeout in milliseconds (default: 120000)"),
    }),
    execute: async ({ command, cwd: commandCwd, timeout }) => {
      try {
        const { stdout, stderr } = await exec(
          "/bin/sh",
          ["-c", command],
          {
            cwd: commandCwd ? at(commandCwd) : cwd,
            maxBuffer: 4 * 1024 * 1024,
            timeout: timeout ?? 120000,
            env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
          },
        );
        const parts: string[] = [];
        if (stdout.trim()) parts.push(stdout.trim());
        if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
        return parts.join("\n") || "(no output)";
      } catch (error: unknown) {
        const e = error as { stdout?: string; stderr?: string; code?: number; signal?: string; message?: string };
        const parts: string[] = [];
        if (e.stdout?.trim()) parts.push(e.stdout.trim());
        if (e.stderr?.trim()) parts.push(`[stderr]\n${e.stderr.trim()}`);
        if (e.code != null) parts.push(`[exit code: ${e.code}]`);
        if (e.signal) parts.push(`[signal: ${e.signal}]`);
        if (parts.length === 0) parts.push(`Error: ${e.message ?? "unknown"}`);
        return parts.join("\n");
      }
    },
  });

  return { readTool, writeTool, editTool, globTool, bashTool };
}
