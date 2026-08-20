import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgent } from "../agents/registry.js";
import { collectRunWithTrace, type BenchTraceLine } from "../core/runner.js";
import { harvestRoots, isInfrastructureFailure } from "../core/case-harvest.js";
import { ensureDir, readJson, sha256, writeJson } from "./files.js";
import {
  completionFromAssertions,
  decideAssertions,
  type Assertion,
  type DecidedAssertion,
  type TraceEvent,
} from "./trace-assertions.js";
import type { ExecutionRecord, MetricResult } from "./types.js";

/**
 * 一层回归套件：零 LLM。
 *
 * 它回答的问题只有一个 —— **同样的问题会不会再犯**。判据是人批准过的确定性断言，
 * 对着绝对标准判 pass/fail，所以这一层：
 *   - 不启任何 judge（成本 = case 数 × 1 次会话）
 *   - **不需要基线**。基线、噪声带、promote 这套东西存在的唯一原因是 LLM 分数是相对的；
 *     断言不是。给它配基线只会凭空引入「第一版恰好侥幸通过」这种伪信号
 *   - 不做多次重复跑。断言是确定性的，重复跑只会放大模型采样噪声，
 *     并给「重测到通过为止」开一个 p-hacking 的口子
 *
 * 二层（hallucination 等四维 LLM 判定）是另一个问题「是不是变笨了」，
 * 走 quality.ts + InProcessJudge，只在人工精选 case 上跑。
 */

export interface RegressionCase {
  caseId: string;
  agentId: string;
  root: string;
  prompt: string;
  assertions: Assertion[];
  /** 采集来源：user_feedback 经人批准，contract_violation 客观可推 */
  source?: string;
}

export interface RegressionCaseResult {
  caseId: string;
  agentId: string;
  source?: string;
  /**
   * - passed / failed：断言判出来了
   * - invalid：case 或运行环境的问题（无可计分断言、网关故障），**不是员工行为失败**。
   *   混进 failed 会让基础设施抖动变成「提示词退化」，归因彻底错位
   */
  status: "passed" | "failed" | "invalid";
  completion: MetricResult;
  assertions: DecidedAssertion[];
  execution: ExecutionRecord;
  /** 本次 run 的产物目录（trace.jsonl / answer.md / completion.json） */
  root: string;
  invalidReason?: string;
}

export interface RegressionReport {
  schemaVersion: 1;
  campaignId: string;
  agentId: string;
  startedAt: string;
  endedAt: string;
  cases: RegressionCaseResult[];
  summary: { total: number; passed: number; failed: number; invalid: number };
  /** 参与本次的 case 集合指纹，供报告区分「套件变了」与「员工变了」 */
  caseSet: string;
}

interface StoredCase {
  caseId: string;
  agentId: string;
  prompt: string;
  source?: string;
}

/** 加载已晋升的 case（candidates 刻意不加载：没批准的标准不参与判定） */
export function loadRegressionCases(agentId?: string): RegressionCase[] {
  const root = harvestRoots().cases;
  if (!existsSync(root)) return [];
  const agents = agentId ? [agentId] : readdirSync(root);
  const cases: RegressionCase[] = [];
  for (const agent of agents) {
    const agentRoot = join(root, agent);
    if (!existsSync(agentRoot)) continue;
    for (const caseId of readdirSync(agentRoot).sort()) {
      const caseRoot = join(agentRoot, caseId);
      const metaFile = join(caseRoot, "case.json");
      const oracleFile = join(caseRoot, "oracle", "trace.json");
      if (!existsSync(metaFile) || !existsSync(oracleFile)) continue;
      const meta = readJson<StoredCase>(metaFile);
      // 断言取封存的 oracle 而不是 case.json：oracle 才是进 caseSet 指纹的那份，
      // 两处若不一致，以被指纹覆盖的为准
      const oracle = readJson<{ assertions?: Assertion[] }>(oracleFile);
      cases.push({
        caseId: meta.caseId ?? caseId,
        agentId: meta.agentId ?? agent,
        root: caseRoot,
        prompt: meta.prompt,
        assertions: oracle.assertions ?? [],
        source: meta.source,
      });
    }
  }
  return cases;
}

function caseSetFingerprint(cases: RegressionCase[]): string {
  return sha256(
    JSON.stringify(
      cases
        .map((item) => ({ caseId: item.caseId, agentId: item.agentId, prompt: item.prompt.trim(), assertions: item.assertions }))
        .sort((a, b) => `${a.agentId}/${a.caseId}`.localeCompare(`${b.agentId}/${b.caseId}`)),
    ),
  );
}

/** trace 行 → 断言引擎的事件。只有工具行参与断言；文本行留在 jsonl 里供人排查 */
function toTraceEvents(lines: BenchTraceLine[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of lines) {
    if (!("tool" in line)) continue;
    events.push({ id: line.id, sequence: line.seq, tool: line.tool.name, input: line.tool.input, result: line.tool.result });
  }
  return events;
}

/** 一次执行的完整产出：二层要复用同一次执行的轨迹，不能另跑一遍 */
export interface SingleRunOutcome {
  result: RegressionCaseResult;
  execution: ExecutionRecord;
  events: TraceEvent[];
}

export async function runRegressionOnce(
  benchmarkCase: RegressionCase,
  runRoot: string,
): Promise<SingleRunOutcome> {
  const workspace = join(runRoot, "workspace");
  ensureDir(workspace);
  const transcriptFile = join(runRoot, "trace.jsonl");
  const startedAt = new Date().toISOString();
  const agent = getAgent(benchmarkCase.agentId);

  const base = {
    caseId: benchmarkCase.caseId,
    agentId: benchmarkCase.agentId,
    source: benchmarkCase.source,
    root: runRoot,
  };
  const emptyExecution = (endedAt: string, answerText = ""): ExecutionRecord => ({
    schemaVersion: 1,
    executionId: `${benchmarkCase.agentId}-${benchmarkCase.caseId}`,
    startedAt,
    endedAt,
    status: "failed",
    answerText,
    isError: true,
    transcriptFile,
    artifacts: [],
  });

  if (!agent) {
    const execution = emptyExecution(new Date().toISOString());
    return {
      result: {
        ...base,
        status: "invalid",
        invalidReason: `岗位 ${benchmarkCase.agentId} 未注册`,
        completion: { metric: "completion", status: "invalid", numerator: 0, denominator: 0, rate: null },
        assertions: [],
        execution,
      },
      execution,
      events: [],
    };
  }

  let collected;
  try {
    collected = await collectRunWithTrace(
      agent.run({
        prompt: benchmarkCase.prompt,
        // cwd 显式传入，才不会走 per-run 岗位「自己拼目录再 rmSync」的分支
        cwd: workspace,
        // 经验库每天被复盘改写，注入了就没法保证同一提示词两次可比
        memory: "off",
        // 这三项会渲染进 systemPrompt，必须是常量，否则两次跑的 prompt 就不同了
        params: { channel: "bench", chatType: "private", senderName: "bench" },
      }),
    );
  } catch (error) {
    const execution = emptyExecution(new Date().toISOString());
    return {
      result: {
        ...base,
        status: "invalid",
        invalidReason: `执行抛错：${error instanceof Error ? error.message : String(error)}`,
        completion: { metric: "completion", status: "invalid", numerator: 0, denominator: 0, rate: null },
        assertions: [],
        execution,
      },
      execution,
      events: [],
    };
  }
  const endedAt = new Date().toISOString();

  writeFileSync(transcriptFile, `${collected.lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  writeFileSync(join(runRoot, "answer.md"), `${collected.text}\n`, "utf-8");

  const events = toTraceEvents(collected.lines);
  const summary = collected.summary;
  const execution: ExecutionRecord = {
    schemaVersion: 1,
    executionId: `${benchmarkCase.agentId}-${benchmarkCase.caseId}`,
    startedAt,
    endedAt,
    status: summary?.isError ? "failed" : "completed",
    answerText: collected.text,
    isError: Boolean(summary?.isError),
    ...(summary?.errorSource ? { errorSource: summary.errorSource } : {}),
    transcriptFile,
    artifacts: [],
  };

  // 网关限流/超时不是员工行为失败。判 failed 会让基础设施抖动伪装成提示词退化
  if (summary && summary.isError && isInfrastructureFailure(summary)) {
    return {
      result: {
        ...base,
        status: "invalid",
        invalidReason: `基础设施故障（${summary.errorSource ?? "retryable"}），不计入回归判定`,
        completion: { metric: "completion", status: "invalid", numerator: 0, denominator: 0, rate: null },
        assertions: [],
        execution,
      },
      execution,
      events: [],
    };
  }

  const decided = decideAssertions({
    assertions: benchmarkCase.assertions,
    events,
    answerText: collected.text,
    workspace,
  });
  const completion = completionFromAssertions(decided);
  writeJson(join(runRoot, "completion.json"), { schemaVersion: 1, completion, assertions: decided.assertions });

  return {
    result: {
      ...base,
      status: completion.status === "invalid" ? "invalid" : completion.rate === 1 ? "passed" : "failed",
      ...(completion.status === "invalid" ? { invalidReason: String(completion.details?.error ?? "断言不可判定") } : {}),
      completion,
      assertions: decided.assertions,
      execution,
    },
    execution,
    events,
  };
}

/**
 * 跑一层回归。
 *
 * 串行执行：写类岗位并发会互相踩踏工作区，而这一层的成本本来就低，
 * 没有任何理由用并发去换那点时间、再引入一类只在并发下出现的假失败。
 * 调用方负责用 withBenchLock 保证跨触发源不重入。
 */
export async function runRegression(params: { agentId?: string; cases?: RegressionCase[] }): Promise<RegressionReport> {
  const cases = params.cases ?? loadRegressionCases(params.agentId);
  const startedAt = new Date().toISOString();
  const campaignId = `${startedAt.replace(/[:.]/g, "-")}-${params.agentId ?? "all"}`;
  const runsRoot = join(harvestRoots().root, "runs", campaignId);

  const results: RegressionCaseResult[] = [];
  for (const item of cases) {
    const outcome = await runRegressionOnce(item, join(runsRoot, item.agentId, item.caseId));
    results.push(outcome.result);
  }

  const report: RegressionReport = {
    schemaVersion: 1,
    campaignId,
    agentId: params.agentId ?? "all",
    startedAt,
    endedAt: new Date().toISOString(),
    cases: results,
    summary: {
      total: results.length,
      passed: results.filter((item) => item.status === "passed").length,
      failed: results.filter((item) => item.status === "failed").length,
      invalid: results.filter((item) => item.status === "invalid").length,
    },
    caseSet: caseSetFingerprint(cases),
  };
  writeJson(join(runsRoot, "regression.json"), report);
  return report;
}
