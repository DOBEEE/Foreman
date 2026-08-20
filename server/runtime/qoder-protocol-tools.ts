/**
 * 把 Vercel AI SDK 的 inline tool 对象转成 Qoder SDK 的 in-process MCP 工具。
 *
 * ## 为什么是「转换」而不是「重写一遍」
 * 两个 SDK 的工具差异只有三处，全是机械的：
 * 1. 入参 schema：Vercel 收 `z.object({...})`，Qoder 收 **zod raw shape**（`{...}`）→ 取 `.shape`；
 * 2. 返回值：Vercel 回字符串，Qoder 要 MCP 的 `CallToolResult`（`content:[{type:'text',text}]`）；
 * 3. 注册方式：Vercel 直接塞进工具袋，Qoder 要经 `createSdkMcpServer` + `options.mcpServers`。
 *
 * 而**描述、schema、handler 逻辑完全一致**。所以这里只换外壳，
 * `protocol-tools.ts` / `skill-tool.ts` / `delegate-task.ts` / `task-history.ts` 里那些
 * schema 与回调一行都不用改，两个 runtime 共享同一份业务定义，不会各自漂移。
 *
 * ## 工具名前缀这件事必须配套处理
 * Qoder 里自定义工具对模型显示为 `mcp__<server>__<tool>`。而全仓的消费方按**裸名**匹配
 * （`isAskTool`、`e.data.name === "submit_plan"`、`REPORT_DONE_TOOL`）。
 * 所以事件翻译侧必须把前缀剥回裸名 —— 见 qoder-runtime.ts 的 `stripMcpPrefix`。
 */

import { createSdkMcpServer, tool } from "@qoder-ai/qoder-agent-sdk";
import type { CallToolResult } from "@qoder-ai/qoder-agent-sdk";

/** 承载协议工具的 in-process MCP server 名。工具全名即 `mcp__<此名>__<工具名>` */
export const PROTOCOL_SERVER = "foreman";

/** Vercel inline tool 的运行时形状（只取转换需要的三个字段） */
interface VercelLikeTool {
  description?: string;
  inputSchema?: { shape?: Record<string, unknown> };
  execute?: (input: unknown) => unknown;
}

/** 业务 handler 返回的字符串 → MCP CallToolResult */
function toCallToolResult(out: unknown): CallToolResult {
  // handler 已经返回 MCP 形状时原样透传（将来若有工具直接产结构化内容）
  if (out && typeof out === "object" && Array.isArray((out as CallToolResult).content)) {
    return out as CallToolResult;
  }
  const text = typeof out === "string" ? out : JSON.stringify(out ?? null);
  return { content: [{ type: "text", text }] };
}

/**
 * 转换单个工具。名字由调用方给（Vercel 侧名字是工具袋的 key，对象里并不带）。
 *
 * 注意 handler 里**不吞异常**：抛出的错误由 SDK 转成 tool 错误回给模型，
 * 与 Vercel 侧 `applyGuards` 之外的行为一致——静默成功才是最坏的结果。
 */
export function toQoderTool(name: string, vt: VercelLikeTool) {
  const shape = vt.inputSchema?.shape ?? {};
  const execute = vt.execute;
  return tool(
    name,
    vt.description ?? name,
    shape as Parameters<typeof tool>[2],
    async (input: unknown) => {
      if (!execute) return toCallToolResult(`工具 ${name} 没有可执行实现`);
      return toCallToolResult(await execute(input));
    },
  );
}

/**
 * 把整袋 Vercel 协议工具转成一个 in-process MCP server。
 * 返回 server 与工具全名清单（全名要进 `allowedTools`，否则模型看不到）。
 */
export function buildQoderProtocolServer(protocolTools: Record<string, unknown>): {
  server: ReturnType<typeof createSdkMcpServer>;
  /** `mcp__foreman__<tool>` 形式的全名，供 allowedTools 授权 */
  qualifiedNames: string[];
} {
  const entries = Object.entries(protocolTools).filter(
    ([, v]) => v && typeof v === "object",
  ) as Array<[string, VercelLikeTool]>;

  const tools = entries.map(([name, vt]) => toQoderTool(name, vt));
  return {
    server: createSdkMcpServer({ name: PROTOCOL_SERVER, tools }),
    qualifiedNames: entries.map(([name]) => qualifiedName(name)),
  };
}

export function qualifiedName(toolName: string): string {
  return `mcp__${PROTOCOL_SERVER}__${toolName}`;
}
