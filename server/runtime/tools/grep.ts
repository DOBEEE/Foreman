import { tool } from "ai";
import { z } from "zod";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const grepParams = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z
    .string()
    .optional()
    .describe("Directory or file to search in (default: cwd)"),
  glob: z
    .string()
    .optional()
    .describe('File glob filter, e.g. "*.ts" or "**/*.tsx"'),
  context: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Lines of context before and after each match (default: 0)"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum number of matching lines to return (default: 100)"),
  caseSensitive: z
    .boolean()
    .optional()
    .describe("Case sensitive search (default: true)"),
});

type GrepInput = z.infer<typeof grepParams>;

function ripgrepArgs(input: GrepInput, searchPath: string): string[] {
  const args = ["--no-heading", "--line-number", "--color=never"];
  if (input.caseSensitive === false) args.push("-i");
  if (input.context && input.context > 0) args.push(`-C${input.context}`);
  if (input.glob) args.push("--glob", input.glob);
  args.push("--", input.pattern, searchPath);
  return args;
}

/** rg 缺失时的等价 POSIX grep 调用：-E 对齐 rg 的正则默认，-I 跳过二进制。 */
function posixGrepArgs(input: GrepInput, searchPath: string): string[] {
  const args = ["-rnIE"];
  if (input.caseSensitive === false) args.push("-i");
  if (input.context && input.context > 0) args.push(`-C${input.context}`);
  if (input.glob) args.push(`--include=${input.glob}`);
  args.push("--", input.pattern, searchPath);
  return args;
}

const isMissingBinary = (e: { code?: number | string; message?: string }) =>
  e.code === "ENOENT" || Boolean(e.message?.includes("ENOENT"));

/**
 * 与 buildFilesystemTools 同理：path 缺省时必须落在**本次 run 的工作目录**，
 * 而不是服务进程的 cwd——否则检索范围与路径门禁的判定基准不一致，门禁可被绕过。
 */
export function buildGrepTool(cwd: string) {
  return tool({
    description:
      "Search file contents using ripgrep. Use for finding code patterns, " +
      "symbol definitions, or text across the codebase. Returns matching lines with file paths and line numbers.",
    inputSchema: grepParams,
    execute: async (input) => {
      const options = { maxBuffer: 1024 * 1024, timeout: 30_000 };
      const searchPath = input.path ? resolve(cwd, input.path) : cwd;
      // rg 只是加速项：宿主没装就退回系统 grep，别把模型逼进 Bash 兜底的多余回合
      const run = async () => {
        try {
          return await exec("rg", ripgrepArgs(input, searchPath), options);
        } catch (error: unknown) {
          if (!isMissingBinary(error as { code?: number | string; message?: string })) throw error;
          return await exec("grep", posixGrepArgs(input, searchPath), options);
        }
      };

      try {
        const { stdout } = await run();
        const lines = stdout.split("\n").filter(Boolean);
        if (lines.length === 0) return "No matches found.";
        // grep 的 -m 按文件计数，与 rg 的全局上限语义不同，统一在这里截断
        const limit = input.maxResults ?? 100;
        if (lines.length <= limit) return lines.join("\n");
        return `${lines.slice(0, limit).join("\n")}\n…[truncated, ${lines.length} matching lines total]`;
      } catch (error: unknown) {
        const e = error as { code?: number | string; message?: string };
        if (e.code === 1) return "No matches found.";
        return `Error: ${e.message ?? "unknown error"}`;
      }
    },
  });
}
