import { existsSync, readFileSync } from "node:fs";
import { LOG_DIR, type RunLogRecord } from "./logger.js";

/**
 * Token 用量与 prompt cache 命中统计（从 runs-*.jsonl 的 usage 字段聚合）。
 *
 * 为什么必须有这个：缓存失效是**静默**的——不报错，只是账单变贵。
 * 真实事故：迁到 VercelRuntime 后 cache_control 一个都没传，命中率从旧运行时的 87.3%
 * 掉到 1.5%、每 run 等效输入从 15 万涨到 94 万，没有任何告警，直到某天额度被打满。
 * 这个模块就是那种回归的探测器。
 */

/** 计价倍数（相对基础输入价）。读远比写便宜，所以「写多少」才是成本大头。 */
const PRICE = {
  /** 缓存读取（命中） */
  read: 0.1,
  /** 缓存写入，5 分钟 TTL */
  write5m: 1.25,
  /** 缓存写入，1 小时 TTL */
  write1h: 2,
} as const;

/** 按任务维度最多返回多少行（按等效成本降序取前 N），避免响应体无上限膨胀 */
const MAX_TASK_ROWS = 40;

interface Counters {
  runs: number;
  steps: number;
  /** 未命中且未写缓存、按全价计费的输入 */
  fresh: number;
  /** 缓存写入（总量；老日志能拆 5m/1h，新日志拆不出来）——也是未命中，只是额外付了写入费 */
  write: number;
  /** 缓存写入中确认走 1h TTL 的部分；只有老的 raw 形状日志才有 */
  write1h: number;
  /** 缓存读取 = 命中 */
  read: number;
  output: number;
  /** 参与过的 agent（任务维度用） */
  agents: Set<string>;
}

export interface CacheStatsRow {
  /** 分组键：agent 维度是 agent 名，任务维度是 taskId */
  key: string;
  /** 展示名（任务维度是任务标题；agent 维度与 key 相同） */
  label: string;
  runs: number;
  /** 平均步数。实测它与读写比几乎线性相关——缓存收益主要来自 run 内的多步工具循环 */
  avgSteps: number;

  // ── token 消耗明细 ──
  /** 未命中·全价输入 */
  freshInput: number;
  /** 未命中·写入缓存（1.25x / 2x） */
  cacheWrite: number;
  /** 命中·读缓存（0.1x） */
  cacheRead: number;
  /** 输出 token */
  outputTokens: number;
  /** 输入合计 = 全价 + 写 + 读 */
  totalInput: number;
  /** 未命中输入合计 = 全价 + 写（都得按 ≥1x 付） */
  missInput: number;
  /** 输入 + 输出 */
  totalTokens: number;

  // ── 派生指标 ──
  /** 命中率 = 命中 / 输入合计 */
  hitRate: number;
  /** 读写比。低于 0.278 时缓存开始亏本（1.25w + 0.1r < w + r 的解） */
  readWriteRatio: number;
  /**
   * 等效输入成本倍数：1.00 = 缓存完全没起作用（等于全价重发）。
   * 旧运行时能做到 0.25，跌到 0.99 就是缓存丢了。
   */
  costMultiple: number;
  /** 相比完全不用缓存省下的比例 */
  savedPercent: number;
}

/** 任务维度的行：额外带上参与的 agent */
export interface CacheTaskRow extends CacheStatsRow {
  agents: string[];
}

export interface CacheStats {
  /** 统计窗口（天） */
  days: number;
  /** 有 usage 记录的 run 数 */
  totalRuns: number;
  agents: CacheStatsRow[];
  /** 按任务聚合（只含 params.taskId 存在的 run），按等效成本降序、最多 MAX_TASK_ROWS 行 */
  tasks: CacheTaskRow[];
  /** 窗口内一共有多少个任务有用量记录（tasks 被截断时用于提示） */
  taskCount: number;
  total: CacheStatsRow;
  /**
   * 确认走 1h TTL 的写入占比。
   * ⚠️ 只有 Anthropic 原生形状的 usage 才带 5m/1h 拆分；ai-sdk 归一化后的
   * LanguageModelUsage 只有 cacheWriteTokens 总量，拆不出来。所以这个值为 0
   * **不能**直接判定「1h beta 没生效」，还要看 ttlSplitAvailable。
   */
  ttl1hShare: number;
  /** 窗口内是否存在能拆 5m/1h 的日志 */
  ttlSplitAvailable: boolean;
}

function emptyCounters(): Counters {
  return {
    runs: 0,
    steps: 0,
    fresh: 0,
    write: 0,
    write1h: 0,
    read: 0,
    output: 0,
    agents: new Set(),
  };
}

/**
 * 归一化 usage。历史上有两种形状，都要认，否则跨运行时的对比会假成 0：
 * - raw：Anthropic 原生 snake_case（旧 Claude SDK 运行时），带 cache_creation 的 5m/1h 拆分
 * - sdk：ai@7 的 LanguageModelUsage（当前 VercelRuntime），inputTokenDetails 三件套，无拆分
 */
function readUsage(
  usage: unknown,
): { fresh: number; write: number; write1h: number; read: number; output: number; split: boolean } | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  if ("cache_read_input_tokens" in u || "input_tokens" in u) {
    const creation = (u.cache_creation ?? {}) as Record<string, unknown>;
    return {
      fresh: num(u.input_tokens),
      write: num(u.cache_creation_input_tokens),
      write1h: num(creation.ephemeral_1h_input_tokens),
      read: num(u.cache_read_input_tokens),
      output: num(u.output_tokens),
      split: "ephemeral_1h_input_tokens" in creation,
    };
  }

  const details = (u.inputTokenDetails ?? {}) as Record<string, unknown>;
  if (Object.keys(details).length === 0 && !("inputTokens" in u)) return undefined;
  return {
    fresh: num(details.noCacheTokens),
    write: num(details.cacheWriteTokens),
    write1h: 0,
    read: num(details.cacheReadTokens),
    output: num(u.outputTokens),
    split: false,
  };
}

/** 等效输入成本（折算成基础输入价的 token 数） */
function inputCost(c: Counters): number {
  const write5m = Math.max(c.write - c.write1h, 0);
  return c.fresh + write5m * PRICE.write5m + c.write1h * PRICE.write1h + c.read * PRICE.read;
}

function toRow(key: string, label: string, c: Counters): CacheStatsRow {
  const totalInput = c.fresh + c.write + c.read;
  const cost = inputCost(c);
  return {
    key,
    label,
    runs: c.runs,
    avgSteps: c.runs > 0 ? c.steps / c.runs : 0,
    freshInput: c.fresh,
    cacheWrite: c.write,
    cacheRead: c.read,
    outputTokens: c.output,
    totalInput,
    missInput: c.fresh + c.write,
    totalTokens: totalInput + c.output,
    hitRate: totalInput > 0 ? c.read / totalInput : 0,
    readWriteRatio: c.write > 0 ? c.read / c.write : 0,
    // 反事实基准：完全没有缓存时，这些 token 全按全价当输入发一遍
    costMultiple: totalInput > 0 ? cost / totalInput : 0,
    savedPercent: totalInput > 0 ? 1 - cost / totalInput : 0,
  };
}

/**
 * 聚合最近 days 天的 token 用量与缓存命中。
 * 任务标题这里给不出来（core 不能反向依赖 boss），只返回 taskId，由调用方补 label。
 */
export function collectCacheStats(days = 7): CacheStats {
  const byAgent = new Map<string, Counters>();
  const byTask = new Map<string, Counters>();
  const total = emptyCounters();
  let splitAvailable = false;
  const now = Date.now();

  for (let i = 0; i < days; i++) {
    const day = new Date(now - i * 86400_000).toISOString().slice(0, 10);
    const file = `${LOG_DIR}runs-${day}.jsonl`;
    if (!existsSync(file)) continue;
    let lines: string[];
    try {
      lines = readFileSync(file, "utf-8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line) continue;
      let rec: RunLogRecord;
      try {
        rec = JSON.parse(line) as RunLogRecord;
      } catch {
        continue; // 坏行跳过
      }
      const u = readUsage(rec.usage);
      if (!u) continue;
      if (u.split) splitAvailable = true;

      const agent = rec.agent || "?";
      const taskId = (rec.params as { taskId?: unknown } | undefined)?.taskId;
      const buckets: Counters[] = [total];

      let c = byAgent.get(agent);
      if (!c) {
        c = emptyCounters();
        byAgent.set(agent, c);
      }
      buckets.push(c);

      if (typeof taskId === "string" && taskId) {
        let t = byTask.get(taskId);
        if (!t) {
          t = emptyCounters();
          byTask.set(taskId, t);
        }
        t.agents.add(agent);
        buckets.push(t);
      }

      for (const b of buckets) {
        b.runs++;
        b.steps += rec.numTurns ?? 0;
        b.fresh += u.fresh;
        b.write += u.write;
        b.write1h += u.write1h;
        b.read += u.read;
        b.output += u.output;
      }
    }
  }

  const agents = [...byAgent.entries()]
    .map(([k, c]) => toRow(k, k, c))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const tasks: CacheTaskRow[] = [...byTask.entries()]
    .map(([k, c]) => ({ ...toRow(k, k, c), agents: [...c.agents].sort() }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    days,
    totalRuns: total.runs,
    agents,
    tasks: tasks.slice(0, MAX_TASK_ROWS),
    taskCount: tasks.length,
    total: toRow("__total__", "合计", total),
    ttl1hShare: total.write > 0 ? total.write1h / total.write : 0,
    ttlSplitAvailable: splitAvailable,
  };
}
