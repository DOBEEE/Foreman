import type { ToolGuard } from "../runtime/hooks.js";

/**
 * 项目自有类型定义——替代 @anthropic-ai/claude-agent-sdk 的 Options 类型。
 *
 * 迁移到 Vercel AI SDK 后，这些类型是 base-agent → runner → vercel-runtime 之间的契约。
 * 不再依赖任何外部 SDK 的类型系统。
 */

/** MCP server 声明（stdio/http/sse） */
export interface McpServerDecl {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** MCP server 配置表 */
export type McpServerMap = Record<string, McpServerDecl | Record<string, unknown>>;

/** Subagent 定义 */
export interface SubagentDef {
  model?: string;
  maxTurns?: number;
  tools?: string[];
  systemPrompt?: string;
  [key: string]: unknown;
}

/**
 * AgentOptions：base-agent.buildOptions() 的返回类型。
 * 是 agent 层向 runner/runtime 传递所有运行参数的契约。
 */
export interface AgentOptions {
  [key: string]: unknown;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  env?: Record<string, string>;
  abortController?: AbortController;
  resume?: string;
  persistSession?: boolean;

  /** 系统提示词（纯字符串，或 preset+append 结构） */
  systemPrompt?: string | { type: string; preset?: string; append?: string };

  /** 外部 MCP server 声明 */
  mcpServers?: McpServerMap;

  /**
   * 工具级门禁：每次工具调用前跑，deny 则不执行并把原因回给模型。
   * 这是**唯一生效**的拦截机制（runtime 是 Vercel AI SDK，SDK hook 那套没有执行点）。
   */
  guards?: ToolGuard[];

  /** MCP 授权范围（mcp__server / mcp__server__tool）：runtime 在注册期据此过滤 */
  mcpAllow?: string[];

  /** 工具白名单（工具名数组）：runtime 据此裁剪内置工具袋 */
  tools?: string[] | Record<string, unknown>;

  /** 内联工具（Vercel ToolSet，runtime 注册用） */
  inlineTools?: Record<string, unknown>;

  /** 工具白名单/黑名单 */
  allowedTools?: string[];
  disallowedTools?: string[];

  /** 权限模式（仅为兼容，runtime 始终为 bypassPermissions） */
  permissionMode?: string;
  settingSources?: unknown[];

  /** 权限回调（过渡期保留） */
  canUseTool?: (toolName: string) => Promise<{ behavior: string; message?: string }>;

  /** 杂项 */
  includePartialMessages?: boolean;
  maxThinkingTokens?: number;

  /** Prompt cache 保留档位（来自 profile.cacheRetention）；runtime 据此决定 cache_control 的 ttl */
  cacheRetention?: "short" | "long";
}
