import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { format } from "node:util";
import { logDir } from "../config/paths.js";
import { config } from "../config/index.js";

/** 日志目录：<仓库根>/logs/（.gitignore 已忽略），带尾斜杠便于拼接 */
export const LOG_DIR = `${logDir}/`;

/**
 * 记录归属：把临时工的记录与正式成员的分开。
 *
 * 用一个可查询字段而不是拆独立日志文件——看板的 trace 回放按 `traces-*.jsonl` 扫目录，
 * 改文件名会让临时工的执行过程在看板上直接看不见，而「区分」用一个字段就够了。
 */
export type AgentKind = "builtin" | "employee" | "temp";

export interface RunLogRecord {
  time: string;
  runId?: string;
  agent: string;
  agentKind?: AgentKind;
  channel?: string;
  prompt: string;
  params?: Record<string, unknown>;
  text: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  numTurns?: number;
  durationMs?: number;
  usage?: unknown;
  sessionId?: string;
  isError?: boolean;
  error?: string;
  /**
   * 错误来源与是否可重试，由 runtime 归一化后透传。
   * case 采集靠它区分「基础设施故障」（限流/超时/鉴权失败，不是员工的错，
   * 采进 case 集只会永久污染）与「员工行为失败」——靠 error 文本猜关键字不可靠。
   */
  errorSource?: "model_gateway" | "runtime";
  retryable?: boolean;
}

/** trace 事件：seq 全局递增，t 为距 run 开始的毫秒偏移 */
export type TraceEvent =
  | { seq: number; t: number; type: "text"; text: string }
  | { seq: number; t: number; type: "thinking"; text: string }
  | { seq: number; t: number; type: "tool_call"; id: string; name: string; input: unknown }
  | { seq: number; t: number; type: "tool_result"; toolUseId: string; isError?: boolean; content: unknown }
  /** 上下文压缩边界：说明这轮在此处丢过早期细节（归因「为什么后面忘了前面」的关键线索） */
  | {
      seq: number;
      t: number;
      type: "compact";
      trigger: string;
      preTokens: number;
      postTokens?: number;
    }
  | { seq: number; t: number; type: "result"; subtype: string; isError: boolean }
  /**
   * 运行环境层面的异常但不中断执行。首个用例：MCP server 连接失败——
   * 工具袋会静默少一批工具（模型能力被削），且工具定义变化会作废整条 prompt cache 前缀。
   * 光 console.warn 事后没人翻，落进 trace 才能在 dashboard 回放里看见。
   */
  | { seq: number; t: number; type: "notice"; level: "warn" | "error"; message: string };

/** 一次完整执行的 trace（每 run 一行 JSONL），runId 与 runs-*.jsonl 关联 */
export interface TraceRecord {
  runId: string;
  time: string;
  agent: string;
  agentKind?: AgentKind;
  channel?: string;
  prompt: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  numTurns?: number;
  durationMs?: number;
  usage?: unknown;
  isError: boolean;
  error?: string;
  /** 见 RunLogRecord：case 采集据此排除基础设施故障 */
  errorSource?: "model_gateway" | "runtime";
  retryable?: boolean;
  events: TraceEvent[];
  /** 超过事件上限后被丢弃的条数 */
  droppedEvents?: number;
}

/** 序列化并截断超长值，保留原始长度信息供分析时判断「超长输出」 */
export function truncate(value: unknown, max: number): unknown {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str == null || str.length <= max) return value;
  return `${str.slice(0, max)}…[truncated, total ${str.length} chars]`;
}

/**
 * 追加一条对话执行日志到 <repo>/logs/runs-YYYY-MM-DD.jsonl（每行一条 JSON）。
 * 写入失败仅告警，绝不影响主流程。
 */
export function appendRunLog(record: RunLogRecord): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = record.time.slice(0, 10);
    appendFileSync(`${LOG_DIR}runs-${day}.jsonl`, JSON.stringify(record) + "\n");
  } catch (error) {
    console.warn("[logger] 写执行日志失败:", error);
  }
}

/**
 * 某员工在某天是否真的被派过活（runs 日志里有它的一条 run）。
 *
 * 复盘据此跳过「当天没活动」的岗位——没干活就没有可提炼的经验，还照开一个独立
 * session 是纯烧 token。用 runs 而非 traces：runs 更轻（不含 events 数组），
 * 且写笔记本身也是一次 run，所以 runs 是「有没有活动」的完备信号，不会漏掉只写了笔记的岗位。
 *
 * fail-open：读不到日志（缺文件/损坏行）一律当「无活动」返回 false。误判方向安全——
 * 最坏是让一个其实没活的岗位被跳过，绝不会因为日志问题去漏跑一个真有活的岗位；
 * 而真有活动时这条 run 必然已落盘，不受读取异常影响。
 */
export function agentActiveOn(agentName: string, date: string): boolean {
  let content: string;
  try {
    content = readFileSync(`${LOG_DIR}runs-${date}.jsonl`, "utf-8");
  } catch {
    return false;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      if ((JSON.parse(line) as RunLogRecord).agent === agentName) return true;
    } catch {
      // 损坏行跳过：单行解析失败不该让整个判定误报
    }
  }
  return false;
}

/** 追加一条完整 trace 到 <repo>/logs/traces-YYYY-MM-DD.jsonl。写入失败仅告警 */
export function appendTraceLog(record: TraceRecord): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = record.time.slice(0, 10);
    appendFileSync(`${LOG_DIR}traces-${day}.jsonl`, JSON.stringify(record) + "\n");
  } catch (error) {
    console.warn("[logger] 写 trace 日志失败:", error);
  }
}

/**
 * 把 console.log/info/warn/error 同步落盘到 <repo>/logs/server-YYYY-MM-DD.log，
 * 让 [boss] / [dingtalk] / [env] 等运行期报错（如 401）在项目里可回查。
 * 控制台原样输出不受影响；落盘失败静默忽略。
 *
 * 幂等：重复调用会把包装函数再包一层，同一行日志被写多遍（现在每个交互会话都会调它）。
 */
let consoleMirrored = false;

export function mirrorConsoleToFile(): void {
  if (consoleMirrored) return;
  consoleMirrored = true;
  const levels = ["log", "info", "warn", "error"] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        mkdirSync(LOG_DIR, { recursive: true });
        const now = new Date().toISOString();
        appendFileSync(
          `${LOG_DIR}server-${now.slice(0, 10)}.log`,
          `${now} [${level}] ${format(...args)}\n`,
        );
      } catch {
        // 落盘失败不影响控制台输出
      }
    };
  }
}

/** 渠道消息日志：一进一出各一条 */
export interface MessageLogRecord {
  time: string;
  /** in=用户发来的消息，out=回复给用户的消息 */
  direction: "in" | "out";
  channel: string;
  chatType?: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
  text: string;
  /** out 带可点按钮卡片时的按钮标题摘要（如「继续 | 缩小范围 | 取消」） */
  card?: string;
  /** out 发送失败时的错误信息 */
  error?: string;
}

/**
 * 追加一条渠道消息日志到 <repo>/logs/messages-YYYY-MM-DD.jsonl。写入失败仅告警。
 *
 * 同时写入规范化的 chat-store：这里是所有入站/出站消息的**唯一收口**
 * （channels/manager、boss/delivery、dingtalk/channel 全部经过），
 * 在别处接线都会漏掉一部分消息。
 */
export function appendMessageLog(record: MessageLogRecord): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = record.time.slice(0, 10);
    appendFileSync(`${LOG_DIR}messages-${day}.jsonl`, JSON.stringify(record) + "\n");
  } catch (error) {
    console.warn("[logger] 写消息日志失败:", error);
  }
  // 动态 import 打破循环依赖（chat-store 需要本文件的 LOG_DIR 与 MessageLogRecord）
  void import("./chat-store.js")
    .then((m) => m.appendChatMessage(record))
    .catch(() => {
      /* 会话记录落盘失败不影响消息投递 */
    });
}

/**
 * 清理超期日志（按天分片的 `<kind>-YYYY-MM-DD.jsonl` 整文件删）。
 *
 * 为什么要有：`logs/` 是唯一没有保留期的目录（笔记 14 天、工作台 60 天、任务工作目录 3 天），
 * 本机已经涨到 21M 且只会继续涨。而任务的**结论**现在有长期档案兜着
 * （见 core/task-archive.ts），日志留的是过程细节，过一定时间价值衰减很快。
 *
 * **默认不开**（config.logs.retentionDays 缺省 0）：删日志不可逆，而多久算「过期」
 * 取决于你还想不想回看那段 trace，这个只能由人定，不该由代码替你定。
 * 开法：settings.json 的 `logs.retentionDays`、环境变量 `LOGS_RETENTION_DAYS`，或 app.json。
 *
 * 只删按日期分片的 jsonl；vite.log 这类非分片文件一律不碰。
 */
export function cleanupLogs(ttlDays = config.logs.retentionDays): number {
  if (!ttlDays || ttlDays <= 0) return 0;
  const cutoff = new Date(Date.now() - ttlDays * 86400_000).toISOString().slice(0, 10);
  let removed = 0;
  try {
    for (const name of readdirSync(LOG_DIR)) {
      const m = /^[a-z-]+-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      if (m[1] >= cutoff) continue;
      try {
        rmSync(`${LOG_DIR}${name}`);
        removed++;
      } catch {
        /* 单个删不掉不影响其余 */
      }
    }
  } catch {
    return 0; // 目录还不存在
  }
  if (removed > 0) console.log(`[logger] 清理了 ${removed} 个超过 ${ttlDays} 天的日志文件`);
  return removed;
}
