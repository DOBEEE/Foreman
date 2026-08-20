import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import { loadAgentProfile } from "../config/agent-profile.js";
import { ensureDir, sha256, writeJson } from "./files.js";
import { loadRegressionCases, runRegressionOnce, type RegressionCase } from "./regression.js";
import { harvestRoots } from "../core/case-harvest.js";
import { prepareGenericQualityEvidence } from "./evidence.js";
import { declaredQualityMetrics, judgeQualityMetrics } from "./quality.js";
import { completionFromAssertions, decideAssertions } from "./trace-assertions.js";
import { InProcessJudge, JUDGE_REVISION } from "./judge.js";
import { rubricsRoot } from "./rubrics.js";
import { aggregateMetrics } from "./aggregate.js";
import { hashTree } from "./files.js";
import type { BenchmarkCase, CampaignReport, RunResult } from "./types.js";

/**
 * 二层质量评测：四个维度由 LLM 评测师判定。
 *
 * 与一层的分工：一层答「同样的问题会不会再犯」，判据是确定性断言、绝对标准；
 * 二层答「是不是整体变笨了」，那是断言表达不了的全局属性，只能靠 LLM 判。
 *
 * 成本上的差别是一个数量级（每 case 每轮 1 次被测 + 4 次评测会话），所以二层：
 *   - 只跑**已升级**的 case（有 oracle/requirements.json 的）
 *   - 只在明确需要时跑，不排周期
 *   - 跑多轮，因为 LLM 判定有真实波动（实测同一提示词三次跑出 0 / 0.1667 / 0），
 *     单轮的分数不足以支撑任何判断
 *
 * 未升级的 case 不会被拉进来：它们没有事实源，问了只会拿到 not_applicable。
 */

/** 二层默认跑几轮。3 轮是能算出离散度（噪声带）的最小值 */
const DEFAULT_RUNS = 3;

/** 只有升级过的 case 才是二层 case */
export function loadQualityCases(agentId?: string): BenchmarkCase[] {
  return loadRegressionCases(agentId)
    .filter((item) => existsSync(join(item.root, "oracle", "requirements.json")))
    .map(toBenchmarkCase);
}

function toBenchmarkCase(item: RegressionCase): BenchmarkCase {
  const conventionsPath = join(item.root, "conventions-ref.json");
  return {
    root: item.root,
    meta: {
      schemaVersion: 1,
      caseId: item.caseId,
      agentId: item.agentId,
      ...(item.source ? { source: item.source } : {}),
    },
    inputRoot: join(item.root, "input"),
    oracleRoot: join(item.root, "oracle"),
    prompt: item.prompt,
    promptFile: join(item.root, "input", "prompt.md"),
    ...(existsSync(conventionsPath) ? { conventionsPath } : {}),
    fingerprint: hashTree(item.root),
  };
}

/**
 * evaluator 指纹取整个 bench 目录的内容哈希 + 判定契约的语义版本。
 *
 * 宁可过度失效不可漏失效：改 aggregate.ts 也会让基线失效，虽然它可能与本次判定无关。
 * 反过来（只哈希"相关"文件）需要人去维护那份清单，而清单漏一个就是静默的不可比。
 */
function evaluatorFingerprint(): string {
  const here = new URL(".", import.meta.url).pathname;
  return sha256(`${hashTree(here)}:${JUDGE_REVISION}`);
}

/** 参与本次的 case 集合指纹 */
function caseSetFingerprint(cases: BenchmarkCase[]): string {
  return sha256(
    JSON.stringify(
      cases
        .map((item) => ({ caseId: item.meta.caseId, fingerprint: item.fingerprint }))
        .sort((a, b) => a.caseId.localeCompare(b.caseId)),
    ),
  );
}

/**
 * 运行期状态指纹：被测的那一侧。
 *
 * 提示词改了它必然变，所以它是「被量的东西」而不是「尺子」——门禁据此判断
 * 候选轮到底有没有真的换成新提示词（相同即说明候选没生效，那份证据是假的）。
 */
function runtimeStateFingerprint(agentId: string): string {
  const profile = loadAgentProfile(agentId);
  return sha256(
    JSON.stringify({
      profile: profile ? { systemPrompt: profile.systemPrompt, tools: profile.tools, maxTurns: profile.maxTurns } : null,
      knowledge: existsSync(config.knowledgeDir) ? hashTree(config.knowledgeDir) : "none",
      memoryInjection: "off",
    }),
  );
}

async function evaluateOne(params: {
  benchmarkCase: BenchmarkCase;
  regressionCase: RegressionCase;
  runRoot: string;
  judge: InProcessJudge;
}): Promise<RunResult> {
  const { benchmarkCase, regressionCase, runRoot, judge } = params;
  const executed = await runRegressionOnce(regressionCase, runRoot);
  const paths = {
    root: runRoot,
    workspace: join(runRoot, "workspace"),
    evidence: join(runRoot, "evidence"),
    judge: join(runRoot, "judge"),
    oracle: benchmarkCase.oracleRoot,
  };
  ensureDir(paths.judge);

  const base = {
    schemaVersion: 1 as const,
    runId: `${benchmarkCase.meta.caseId}-${executed.execution.startedAt}`,
    caseId: benchmarkCase.meta.caseId,
    agentId: benchmarkCase.meta.agentId,
    execution: executed.execution,
    paths,
  };

  // 被测执行本身就没跑成 —— 判 invalid，别让评测师去判一份不存在的答复
  if (executed.result.status === "invalid") {
    return {
      ...base,
      status: "invalid",
      metrics: [
        { metric: "completion", status: "invalid", numerator: 0, denominator: 0, rate: null, details: { error: executed.result.invalidReason } },
      ],
    };
  }

  const completion = completionFromAssertions(
    decideAssertions({
      assertions: regressionCase.assertions,
      events: executed.events,
      answerText: executed.execution.answerText,
      workspace: paths.workspace,
    }),
  );

  const evidenceFile = prepareGenericQualityEvidence({
    benchmarkCase,
    paths,
    execution: executed.execution,
    knowledgeRoot: config.knowledgeDir,
  });
  const evidence = JSON.parse(readFileSync(evidenceFile, "utf8")) as Record<string, unknown>;

  const judgments = await judgeQualityMetrics({
    judge,
    paths,
    execution: executed.execution,
    rubricRoot: rubricsRoot(),
    evidenceFile,
    evidence,
    declared: declaredQualityMetrics({
      oracleRoot: benchmarkCase.oracleRoot,
      ...(benchmarkCase.conventionsPath ? { conventionsPath: benchmarkCase.conventionsPath } : {}),
    }),
  });

  const metrics = [completion, ...judgments];
  const degraded = metrics
    .filter((item) => item.status === "unavailable" || item.status === "judge_error")
    .map((item) => item.metric);
  return {
    ...base,
    status: metrics.some((item) => item.status === "invalid") ? "invalid" : executed.execution.isError ? "failed" : "completed",
    metrics,
    ...(degraded.length ? { degradedMetrics: degraded } : {}),
  };
}

/**
 * 跑二层。
 *
 * 串行：并发会让多个评测师会话与被测会话抢同一个模型配额，而限流会被记成
 * judge_error —— 那是假失败，比慢几分钟坏得多。
 */
export async function runQualityCampaign(params: {
  agentId: string;
  runs?: number;
}): Promise<{ ok: boolean; message: string; report?: CampaignReport }> {
  const cases = loadQualityCases(params.agentId);
  if (!cases.length) {
    return {
      ok: false,
      message:
        `${params.agentId} 没有二层 case（需要 oracle/requirements.json）。` +
        `\n二层 case 由一层稳定后自动起草、经你确认升级而来，跑 foreman bench cases 看进度`,
    };
  }
  const regressionCases = loadRegressionCases(params.agentId);
  const runs = params.runs ?? DEFAULT_RUNS;
  const startedAt = new Date().toISOString();
  const campaignId = `${startedAt.replace(/[:.]/g, "-")}-${params.agentId}-quality`;
  const root = join(harvestRoots().root, "quality", campaignId);
  const judge = new InProcessJudge();

  const results: RunResult[] = [];
  for (let round = 0; round < runs; round += 1) {
    for (const benchmarkCase of cases) {
      const regressionCase = regressionCases.find((item) => item.caseId === benchmarkCase.meta.caseId);
      if (!regressionCase) continue;
      results.push(
        await evaluateOne({
          benchmarkCase,
          regressionCase,
          runRoot: join(root, `round-${round + 1}`, benchmarkCase.meta.caseId),
          judge,
        }),
      );
    }
  }

  const report: CampaignReport = {
    schemaVersion: 1,
    campaignId,
    agentId: params.agentId,
    startedAt,
    endedAt: new Date().toISOString(),
    runs: results,
    metrics: aggregateMetrics(results),
    fingerprints: {
      target: existsSync(config.serviceRoot) ? hashTree(join(config.serviceRoot, "server")) : "unknown",
      caseSet: caseSetFingerprint(cases),
      evaluator: evaluatorFingerprint(),
      runtimeState: runtimeStateFingerprint(params.agentId),
    },
  };
  const file = join(root, "campaign.json");
  writeJson(file, report);
  return { ok: true, message: `二层评测完成：${file}`, report };
}
