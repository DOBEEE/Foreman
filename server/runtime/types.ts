/**
 * AgentRuntime：SDK 无关的 LLM 执行抽象。
 * 业务层（boss / agents / scheduler）只消费这个接口，不直接依赖任何 SDK 包。
 * 实现：vercel-runtime.ts（Vercel AI SDK）、qoder-runtime.ts（Qoder CLI SDK）。
 */

/** 可选的 runtime 实现。由启动参数 --runtime / 环境变量 FOREMAN_RUNTIME 决定，全局生效 */
export type RuntimeKind = "vercel" | "qoder";

/** 全部合法取值（参数校验与错误文案共用一份，避免两处漂移） */
export const RUNTIME_KINDS: readonly RuntimeKind[] = ["vercel", "qoder"];

export function isRuntimeKind(v: string): v is RuntimeKind {
  return (RUNTIME_KINDS as readonly string[]).includes(v);
}

/** 执行输出事件（与现有 AgentEvent 对齐，保持消费方零改动） */
export interface RuntimeEvent {
  event:
    | "session"
    | "text"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "result"
    | "compact"
    | "progress"
    /** 不中断执行、但上层必须能看到的运行环境异常（如 MCP 连接失败导致工具袋缺工具） */
    | "notice";
  data: Record<string, unknown>;
}

/** 多轮 agent 执行的输入 */
export interface RuntimeRunInput {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxSteps?: number;
  env?: Record<string, string>;
  cwd?: string;
  abortSignal?: AbortSignal;
  /** SDK 专属配置（opaque）：从 buildOptions 传入，具体 runtime 自己解读 */
  sdkOptions?: Record<string, unknown>;
  /** 多轮 session resume */
  resume?: string;
  persistSession?: boolean;
}

/** 单轮无工具 LLM 调用的输入（路由/验收/裁决/反馈识别） */
export interface RuntimeCompleteInput {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  env?: Record<string, string>;
  cwd?: string;
  abortSignal?: AbortSignal;
  /** 直答场景的会话续接 */
  resume?: string;
  persistSession?: boolean;
}

/** 单轮调用的结果 */
export interface RuntimeCompleteResult {
  text: string;
  sessionId?: string;
  isError: boolean;
}

/** Runtime 接口：所有 SDK 实现都要满足这两个方法 */
export interface AgentRuntime {
  /** 多轮 agent 执行（带工具循环、streaming） */
  run(input: RuntimeRunInput): AsyncGenerator<RuntimeEvent>;
  /** 单轮无工具 LLM 调用（路由/验收/裁决/反馈识别） */
  complete(input: RuntimeCompleteInput): Promise<RuntimeCompleteResult>;
}
