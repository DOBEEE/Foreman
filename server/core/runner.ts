import { getRuntime } from "../runtime/index.js";
import { truncate } from "./logger.js";

export interface RunInput {
  prompt: string;
  maxTurns?: number;
  /** 业务入参，供 agent 动态拼接系统提示词（模板 {{key}} 占位） */
  params?: Record<string, unknown>;
  /** 多轮会话：resume 指定 sessionId */
  resume?: string;
  /** 渠道场景置 true，使 result 消息带 sessionId 供下轮 resume */
  persistSession?: boolean;
  /** 本次 run 的工作目录覆盖（per-run 隔离时由 BaseAgent.run 注入） */
  cwd?: string;
  /**
   * 'off' = 本次不注入岗位经验库。评测专用：复盘每天改写经验库，
   * 注入了同一份 prompt 两次跑就不可比。缺省 = 按 profile.retro 正常注入。
   */
  memory?: "off";
  abortController?: AbortController;
}

/** 一轮执行的汇总 */
export interface RunSummary {
  subtype: string;
  isError: boolean;
  result?: string;
  sessionId?: string;
  taskId?: string;
  numTurns?: number;
  durationMs?: number;
  usage?: unknown;
  /** 错误来源与恢复建议，由 runtime 归一化，避免 boss 猜错成渠道限流。 */
  errorSource?: "model_gateway" | "runtime";
  retryable?: boolean;
  statusCode?: number;
}

/** workflow 步骤进度（parentId 表达嵌套） */
export interface ProgressData {
  id: string;
  parentId?: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
  /**
   * 该步骤执行者的 **agent 名**（如 `coder`），不是显示名。
   * 显示名由各展示层自己过 employeeDisplayName —— 事件生成侧在 agents 层，
   * 不能反向 import boss/persona。
   */
  employee?: string;
  /** 步序，从 1 起。仅顶层步骤带；评审等子步骤不带 */
  index?: number;
  /** 顶层步骤总数，与 index 配对出现 */
  total?: number;
}

/** 归一化后推给 SSE 的事件 */
export type AgentEvent =
  | { event: "text"; data: { text: string } }
  | { event: "thinking"; data: { text: string } }
  | { event: "tool_call"; data: { id: string; name: string; input: unknown } }
  | { event: "tool_result"; data: { toolUseId: string; isError?: boolean; content: unknown } }
  | { event: "progress"; data: ProgressData }
  | { event: "session"; data: { sessionId: string } }
  | {
      event: "compact";
      data: {
        trigger: string;
        preTokens: number;
        postTokens?: number;
        durationMs?: number;
      };
    }
  | { event: "result"; data: RunSummary }
  /** 不中断执行、但上层必须能看到的运行环境异常（如 MCP 连接失败导致工具袋缺工具） */
  | { event: "notice"; data: { level: "warn" | "error"; message: string } };

/** collectRun 的聚合输出 */
export interface CollectedRun {
  /** 全部文本增量拼接 */
  text: string;
  toolCalls: unknown[];
  /** 本轮汇总；流被中断/异常时可能为 undefined */
  summary?: RunSummary;
}

/** 聚合一个事件流（渠道回复、JSON 响应等一次性场景复用） */
export async function collectRun(
  events: AsyncGenerator<AgentEvent>,
): Promise<CollectedRun> {
  const textParts: string[] = [];
  const toolCalls: unknown[] = [];
  let summary: RunSummary | undefined;
  for await (const e of events) {
    if (e.event === "text") textParts.push(e.data.text);
    else if (e.event === "tool_call") toolCalls.push(e.data);
    else if (e.event === "result") summary = e.data;
  }
  return { text: textParts.join(""), toolCalls, summary };
}

/**
 * 外部评测消费的逐行 trace。
 * 只有含 `tool.name` 的行会被评测侧解析成工具事件；文本行不参与解析，
 * 但保留下来供 judge 直接阅读（否则它只能看到工具序列、看不到 agent 的明文推理）。
 */
export type BenchTraceLine =
  | { seq: number; t: number; kind: "text" | "thinking" | "notice"; text: string }
  | { seq: number; t: number; kind: "result"; summary: RunSummary }
  | {
      id: string;
      seq: number;
      t: number;
      tool: { name: string; input: unknown; result: { isError: boolean; content: unknown } | null };
    };

export interface CollectedRunWithTrace extends CollectedRun {
  lines: BenchTraceLine[];
}

/**
 * 截断阈值故意比 appendTraceLog（2000/4000）宽：judge 要靠工具结果判断
 * agent 有没有正确理解返回内容，4000 会把知识库 Read 的正文切掉。
 * 上限仍需存在，否则 judge 上下文会被单次大 Read 撑爆。
 */
const BENCH_INPUT_MAX = 8000;
const BENCH_CONTENT_MAX = 16000;

/**
 * 聚合事件流并同时产出逐行 trace：工具调用与其结果按 toolUseId 配对进同一行。
 * 与 collectRun 的差别仅在于多返回 lines，调用方语义不变。
 */
export async function collectRunWithTrace(
  events: AsyncGenerator<AgentEvent>,
  startMs: number = Date.now(),
): Promise<CollectedRunWithTrace> {
  const textParts: string[] = [];
  const toolCalls: unknown[] = [];
  let summary: RunSummary | undefined;
  const lines: BenchTraceLine[] = [];
  /** 等待结果回填的工具行，按 tool_use id 索引 */
  const pending = new Map<string, Extract<BenchTraceLine, { tool: unknown }>>();
  let seq = 0;

  /**
   * 文本缓冲：text/thinking 是逐 delta 流出的，逐条落盘会把一次回答拆成上百行。
   * 连续同类累积成一行，judge 才读得懂。
   */
  let buf: { kind: "text" | "thinking" | "notice"; seq: number; t: number; parts: string[] } | undefined;
  const flush = (): void => {
    if (!buf) return;
    const text = buf.parts.join("");
    if (text) lines.push({ seq: buf.seq, t: buf.t, kind: buf.kind, text });
    buf = undefined;
  };
  const appendText = (kind: "text" | "thinking" | "notice", t: number, chunk: string): void => {
    if (!chunk) return; // 空 delta 不占 seq，也不落盘
    if (buf && buf.kind !== kind) flush();
    buf ??= { kind, seq: seq++, t, parts: [] };
    buf.parts.push(chunk);
  };

  for await (const e of events) {
    const t = Date.now() - startMs;
    if (e.event === "text") {
      textParts.push(e.data.text);
      appendText("text", t, e.data.text);
    } else if (e.event === "thinking") {
      appendText("thinking", t, e.data.text);
    } else if (e.event === "notice") {
      appendText("notice", t, `[${e.data.level}] ${e.data.message}`);
    } else if (e.event === "tool_call") {
      flush();
      toolCalls.push(e.data);
      const row = {
        id: e.data.id,
        seq: seq++,
        t,
        tool: { name: e.data.name, input: truncate(e.data.input, BENCH_INPUT_MAX), result: null },
      } satisfies Extract<BenchTraceLine, { tool: unknown }>;
      lines.push(row);
      pending.set(e.data.id, row);
    } else if (e.event === "tool_result") {
      flush();
      const result = {
        isError: e.data.isError ?? false,
        content: truncate(e.data.content, BENCH_CONTENT_MAX),
      };
      const row = pending.get(e.data.toolUseId);
      if (row) {
        row.tool.result = result;
        pending.delete(e.data.toolUseId);
      } else {
        // 孤儿结果（配不上调用）也要留痕，不能悄悄丢——judge 据此判断轨迹是否完整
        lines.push({
          id: e.data.toolUseId,
          seq: seq++,
          t,
          tool: { name: "unknown", input: null, result },
        });
      }
    } else if (e.event === "result") {
      flush();
      summary = e.data;
      lines.push({ seq: seq++, t, kind: "result", summary: e.data });
    }
  }
  flush();

  // pending 里剩下的是入参校验失败/被中止的调用，保持 result:null 原样留在 lines 中——
  // 「调了但没拿到结果」本身就是 recovery / toolAccuracy 要判的信号
  return { text: textParts.join(""), toolCalls, summary, lines };
}

/**
 * 执行一次 agent 查询，以 async generator 形式流出归一化事件。
 * 委托给 VercelRuntime.run()，通过 MCP + inline tools 驱动多轮 agent loop。
 */
export async function* executeQuery(
  prompt: string,
  options: Record<string, unknown>,
): AsyncGenerator<AgentEvent> {
  const runtime = getRuntime();
  const externalMcp: Record<string, unknown> = {};
  if (options.mcpServers) {
    for (const [name, decl] of Object.entries(options.mcpServers as Record<string, unknown>)) {
      const d = decl as Record<string, unknown>;
      if (d.command || d.url) externalMcp[name] = decl;
    }
  }
  // protocolTools: actual Vercel AI tool instances (ask_user, report_task_done, submit_plan, etc.)
  // These go into sdkOptions.tools where the runtime merges them into its inline tool bag.
  const protocolTools = (options.protocolTools ?? {}) as Record<string, unknown>;
  const input = {
    prompt,
    systemPrompt: extractSystemPrompt(options),
    model: options.model as string | undefined,
    maxSteps: options.maxTurns as number | undefined,
    env: options.env as Record<string, string> | undefined,
    cwd: options.cwd as string | undefined,
    abortSignal: (options.abortController as AbortController | undefined)?.signal,
    resume: options.resume as string | undefined,
    persistSession: options.persistSession as boolean | undefined,
    sdkOptions: {
      tools: protocolTools,
      /**
       * 内置工具白名单（名称数组，来自 profile.tools）。
       * 必须传到 runtime 才是真限制——runtime 的 inline 工具袋默认含 Bash/Write/Edit，
       * 只在 options 里放个名单不会拦住任何东西（临时工的「只读」正靠这条兜底）。
       */
      builtinAllow: options.tools as string[] | undefined,
      /**
       * MCP 授权范围（`mcp__server` / `mcp__server__tool` 写法）。
       * 空数组也有意义——「声明了 tools 但没点名任何 MCP」= 不授权任何 MCP 工具，
       * 所以这里不能用 `?.length` 把空数组吞掉。
       */
      mcpAllow: options.mcpAllow as string[] | undefined,
      guards: options.guards,
      systemPrompt: extractSystemPrompt(options),
      mcpServers: externalMcp,
      /** Prompt cache 档位（profile.cacheRetention）；未给 = short(5m) */
      cacheRetention: options.cacheRetention as "short" | "long" | undefined,
      /**
       * Qoder 的模型档位（profile.qoderModel → config.qoder.model）。
       * 走 sdkOptions 而不是复用顶层 `model`：那个字段装的是 Anthropic/OpenAI 模型名，
       * 两套标识不通用，混在一起会让任一 runtime 拿到对方的名字。
       */
      qoderModel: options.qoderModel as string | undefined,
    },
  };
  for await (const ev of runtime.run(input)) {
    yield ev as AgentEvent;
  }
}

/** 从 options 的 systemPrompt 结构提取纯文本 */
function extractSystemPrompt(options: Record<string, unknown>): string | undefined {
  const sp = options.systemPrompt as
    | string
    | { type: string; preset?: string; append?: string }
    | undefined;
  if (!sp) return undefined;
  if (typeof sp === "string") return sp;
  if (sp.append) return sp.append;
  return undefined;
}
