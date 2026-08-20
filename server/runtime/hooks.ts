import type { Tool } from "ai";

/**
 * Tool Guard：工具执行前的拦截检查（等价于 Claude SDK 的 PreToolUse hook）。
 * 返回 allow 则放行，deny 则阻止执行并返回错误文本给模型。
 */
export type ToolGuard = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ allow: true } | { deny: true; reason: string }>;

/**
 * 对一组 tools 应用 guards：包装每个 tool 的 execute 函数，在执行前逐个跑 guard。
 * 任一 guard deny → 不执行原始 execute，直接返回 [BLOCKED] 错误文本。
 *
 * 这是 Vercel AI SDK 路线下替代 Claude SDK PreToolUse hooks 的核心机制。
 * 比原来的 hook 更优：
 * - MCP 授权改为「不注册未授权工具」而非「注册后拦截」——模型看不到=不会调=省 token
 * - 文件路径门禁从运行时拦截变成执行前检查，同等安全但代码更直观
 */
export function applyGuards<T extends Record<string, Tool>>(
  tools: T,
  guards: ToolGuard[],
): T {
  if (guards.length === 0) return tools;
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools as Record<string, Tool>)) {
    if (!t || typeof (t as { execute?: unknown }).execute !== "function") {
      wrapped[name] = t;
      continue;
    }
    const original = (t as { execute: (...args: unknown[]) => unknown }).execute;
    /**
     * **必须克隆 tool 对象再换 execute，不能就地赋值。**
     * 传进来的 Read/Write/Edit/Bash/grep 是模块级单例（runtime 里直接引用同一个对象），
     * `{...tools}` 只复制了这层 map，对象引用是共享的——就地改 `.execute` 等于改全局。
     *
     * 曾经因此每跑一次 run 就在同一批工具上**永久叠一层 guard**（新层在外、旧层在内）：
     * - 一次调用把历史每一层都跑一遍：实测 3 次 run 后一次 Read 跑 3 遍 guard，
     *   线上单次 Read 被审计记了 18 行。
     * - 任一层 deny 即拦，于是本轮那层放行了、**上一轮那层照旧拦**，报错里带的是
     *   上一轮的 agent 名与放行范围。复盘员工据此连报三轮「写门禁绑错岗位」的假 bug，
     *   还改用 Bash 绕过，反而真的覆写了别人的经验库。
     * - 跨 agent 同样会串：A 的 readRoots 会一直挂着去拦 B 的正常调用。
     */
    wrapped[name] = Object.assign(
      // 保留原型：MCP 那边给的 tool 未必是普通对象字面量，`{...t}` 会把原型拍平
      Object.create(Object.getPrototypeOf(t) as object),
      t,
      {
        execute: async (...args: unknown[]) => {
          const input = (args[0] ?? {}) as Record<string, unknown>;
          for (const guard of guards) {
            const result = await guard(name, input);
            if ("deny" in result && result.deny) {
              return `[BLOCKED] ${result.reason}`;
            }
          }
          return original(...args);
        },
      },
    ) as Tool;
  }
  return wrapped as T;
}

// ─── 常用 Guards（从现有 audit.ts hook 逻辑移植） ─────────────

/** 审计日志 guard：每次工具调用前记一行审计日志 */
export function auditGuard(
  agentName: string,
  logger: (entry: { time: string; agent: string; tool: string; input: unknown }) => void,
): ToolGuard {
  return async (toolName, input) => {
    logger({ time: new Date().toISOString(), agent: agentName, tool: toolName, input });
    return { allow: true };
  };
}

/** 路径门禁 guard：文件类工具的路径必须在 allowedRoots 内 */
export function pathGuard(allowedRoots: string[], sensitivePatterns?: RegExp[]): ToolGuard {
  const FILE_TOOLS = new Set([
    "read_text_file", "read_file", "write_file", "edit_file",
    "read_multiple_files", "move_file", "search_files",
    "list_directory", "directory_tree", "get_file_info",
  ]);
  const SENSITIVE = sensitivePatterns ?? [
    /\.env$/i,
    /\.git\//,
    /\.ssh\//,
    /\.(pem|key|p12|pfx|jks)$/i,
    /secrets?\./i,
    /credentials/i,
  ];

  return async (toolName, input) => {
    if (!FILE_TOOLS.has(toolName)) return { allow: true };
    const paths: string[] = [];
    if (typeof input.path === "string") paths.push(input.path);
    if (typeof input.file_path === "string") paths.push(input.file_path);
    if (typeof input.filePath === "string") paths.push(input.filePath);
    if (Array.isArray(input.paths)) paths.push(...input.paths.filter((p): p is string => typeof p === "string"));

    for (const p of paths) {
      if (SENSITIVE.some((re) => re.test(p))) {
        return { deny: true, reason: `路径命中敏感文件规则：${p}` };
      }
      const inRoot = allowedRoots.some((root) => p.startsWith(root) || p === root);
      if (!inRoot) {
        return { deny: true, reason: `路径越界：${p} 不在允许的目录内 [${allowedRoots.join(", ")}]` };
      }
    }
    return { allow: true };
  };
}

/** 分支保护 guard：阻止 git push 到保护分支 */
export function branchGuard(protectedBranches = ["main", "master", "develop", "release"]): ToolGuard {
  return async (toolName, input) => {
    if (toolName !== "run_process" && toolName !== "bash") return { allow: true };
    const cmd = String(input.command ?? input.cmd ?? "");
    if (!cmd.includes("git") || !cmd.includes("push")) return { allow: true };
    for (const branch of protectedBranches) {
      if (cmd.includes(branch) || cmd.match(new RegExp(`push\\s+\\S+\\s+${branch}`))) {
        return { deny: true, reason: `禁止 push 到保护分支：${branch}` };
      }
    }
    // bare `git push` (no explicit branch) is also dangerous
    if (/git\s+push\s*$/.test(cmd.trim())) {
      return { deny: true, reason: "禁止裸 git push（未指定分支），请明确目标分支" };
    }
    return { allow: true };
  };
}
