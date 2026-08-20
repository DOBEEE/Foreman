import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR, type TraceEvent as LogTraceEvent, type TraceRecord } from "./logger.js";
import type { FeedbackRecord } from "./feedback.js";
import { loadAgentProfile } from "../config/agent-profile.js";
import { deriveContractAssertions } from "./contract-assertions.js";
import { decideAssertions, type TraceEvent } from "../bench/trace-assertions.js";
import { harvestCase, isInfrastructureFailure, type HarvestOutcome } from "./case-harvest.js";

/**
 * case 采集扫描。
 *
 * 为什么是「扫描」而不是运行结束时的内联钩子：用户反馈和它对应的那次执行**不同时发生**
 * （用户过一会儿才说「这不对」），两者只能靠 sessionId 事后 join。内联钩子在 run 结束那一刻
 * 根本还看不到反馈，只能覆盖契约违规那一半。
 *
 * 扫两类信号，都不依赖任何自我评价：
 *   1. 用户负反馈 —— 外部真相。按 sessionId 找回那次执行的 trace
 *   2. 契约违规 —— 用岗位声明派生的断言去判该次 trace，零 LLM、客观
 *
 * `harvestCase` 自己会挡掉基础设施故障、做内容寻址去重、要求复现 ≥2 次，
 * 所以本函数可以放心地反复扫同一批日志：重复扫描只会把 reproductions 计数推高，
 * 而那正是「这问题不是偶发」的判据。
 *
 * ——但重复扫**同一条 run** 会虚假地推高计数，所以按 runId 去重（见 seen）。
 */

export interface SweepResult {
  scannedRuns: number;
  negativeFeedback: number;
  contractViolations: number;
  outcomes: Array<{ agentId: string; runId: string; reason: string; outcome: HarvestOutcome }>;
}

function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 半行/损坏行跳过：日志是追加写的，最后一行可能不完整
    }
  }
  return out;
}

function recentDays(days: number): string[] {
  const now = Date.now();
  return Array.from({ length: days }, (_, i) => new Date(now - i * 86400_000).toISOString().slice(0, 10));
}

/** trace 日志的事件流 → 断言引擎的事件。tool_result 按 toolUseId 配对回填 */
export function traceEventsOf(record: TraceRecord): TraceEvent[] {
  const events: TraceEvent[] = [];
  const byId = new Map<string, TraceEvent>();
  for (const event of record.events ?? ([] as LogTraceEvent[])) {
    if (event.type === "tool_call") {
      const item: TraceEvent = { id: event.id, sequence: event.seq, tool: event.name, input: event.input, result: null };
      events.push(item);
      byId.set(event.id, item);
    } else if (event.type === "tool_result") {
      const item = byId.get(event.toolUseId);
      // 配不上调用的孤儿结果不补造事件：断言只判「调了什么」，凭空造 id 会让 scope 误判
      if (item) item.result = { isError: event.isError ?? false, content: event.content };
    }
  }
  return events;
}

/**
 * 用岗位契约断言判一次执行，返回失败的断言 id。
 * 空数组 = 没违规，或该岗位没声明可派生的边界（两者由调用方按 assertions.length 区分）。
 */
export function contractViolationsOf(record: TraceRecord): string[] {
  const profile = loadAgentProfile(record.agent);
  if (!profile) return [];
  const assertions = deriveContractAssertions(profile);
  if (!assertions.length) return [];
  const decided = decideAssertions({
    assertions,
    events: traceEventsOf(record),
    answerText: "",
    // trace 日志里没有留 run 的工作目录，用不存在的占位符而不是 process.cwd()：
    // 后者会把「服务根目录下的路径」误判成合法范围内，把真实越界洗白
    workspace: "\u0000no-workspace",
  });
  return decided.assertions.filter((item) => item.deterministicStatus === "fail").map((item) => item.id);
}

/**
 * 扫最近 N 天的日志采集 case。
 *
 * @param days 回看天数。默认 7 天：与优化师的周期对齐，也够让一个问题复现两次
 */
export function sweepHarvest(days = 7): SweepResult {
  const result: SweepResult = { scannedRuns: 0, negativeFeedback: 0, contractViolations: 0, outcomes: [] };
  const traces: TraceRecord[] = [];
  const feedback: FeedbackRecord[] = [];
  for (const day of recentDays(days)) {
    traces.push(...readJsonLines<TraceRecord>(join(LOG_DIR, `traces-${day}.jsonl`)));
    feedback.push(...readJsonLines<FeedbackRecord>(join(LOG_DIR, `feedback-${day}.jsonl`)));
  }

  // 负反馈按 sessionId 索引。同一会话多条负反馈取最后一条：用户的最新表述最接近真实不满
  const negativeBySession = new Map<string, FeedbackRecord>();
  for (const item of feedback) {
    if (item.polarity !== "negative" || !item.sessionId) continue;
    negativeBySession.set(item.sessionId, item);
  }

  const seen = new Set<string>();
  for (const record of traces) {
    if (!record.runId || seen.has(record.runId)) continue;
    seen.add(record.runId);
    result.scannedRuns += 1;

    // 基础设施故障在这里就挡住，省掉后面的断言判定
    if (isInfrastructureFailure(record)) continue;

    const negative = record.sessionId ? negativeBySession.get(record.sessionId) : undefined;
    const violations = contractViolationsOf(record);
    if (!negative && !violations.length) continue;

    if (negative) result.negativeFeedback += 1;
    if (violations.length) result.contractViolations += 1;

    const outcome = harvestCase(record, negative);
    result.outcomes.push({
      agentId: record.agent,
      runId: record.runId,
      reason: negative
        ? `用户负反馈（${negative.signal}）`
        : `契约违规：${violations.join(", ")}`,
      outcome,
    });
  }
  return result;
}
