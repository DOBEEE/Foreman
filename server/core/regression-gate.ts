import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";

/**
 * 提示词提案的回归门禁。
 *
 * 存在的理由：优化员的提案是 LLM 归因得出的，批准后直接改员工 systemPrompt，
 * 此前没有任何效果度量。业界已实证（Darwin Gödel Machine）：没有防篡改评测通道的
 * 自进化必然被 reward hack。这里把 agent-bench 的评测结果作为应用前的硬证据。
 *
 * 本模块只做**判定**，不跑评测。agent-bench 一次回归是 15 次 LLM 会话、数分钟量级，
 * 不可能塞进 applyProposal 这种交互式调用里。证据由 agent-bench 离线产出、
 * 落在 <runtimeDir>/agent-bench/ 下，这里读它。
 */

/** agent-bench 的产物根（与代码仓库解耦，随用户运行时目录走） */
const BENCH_ROOT = join(config.runtimeDir, "agent-bench");

/** 用于判定的四项主指标；hallucination 方向相反（越低越好） */
const PRIMARY_METRICS = ["completion", "conventionCompliance", "toolAccuracy", "hallucination"] as const;

/**
 * 必须一致的指纹项 = 评测装置本身。
 *
 * 故意**不含 runtimeState**：提示词就是本次要改的变量，它必然让 runtimeState 变化。
 * 这与 agent-bench evolve 的 candidateVerdict 不同——那边改的是 harness 代码、
 * 被测服务状态应当不变，所以它要求 runtimeState 相等。
 *
 * 含 target：要求 agent-base 代码本身不变，否则「提示词改好了」和「代码改好了」
 * 无法归因到同一个原因上。
 */
const APPARATUS_KEYS = ["suite", "caseSet", "evaluator", "judge", "executionProfile", "target"] as const;

interface MetricResult {
  metric: string;
  status: string;
  rate: number | null;
}

interface CampaignReport {
  campaignId: string;
  suiteId: string;
  profile: { id: string };
  endedAt?: string;
  runs: Array<{ status: string }>;
  metrics: MetricResult[];
  fingerprints: Record<string, string>;
}

export type GateStatus =
  | "pass"
  | "regressed"
  | "no_improvement"
  | "incomparable"
  | "not_measured"
  | "missing_baseline"
  | "missing_candidate"
  | "invalid_runs";

export interface GateVerdict {
  status: GateStatus;
  reason: string;
  /** 逐指标 before → after，供人工复核 */
  deltas?: Array<{ metric: string; baseline: number | null; candidate: number | null; delta: number | null }>;
  baselineCampaignId?: string;
  candidateCampaignId?: string;
}

/** 该员工对应的 suite / profile。约定 suite id 为 agent-base-<员工名> */
export function benchTargetOf(agentId: string): { suiteId: string; profileId: string } {
  return { suiteId: `agent-base-${agentId}`, profileId: "service" };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export function baselineFile(suiteId: string, profileId: string): string {
  return join(BENCH_ROOT, "baselines", suiteId, `${profileId}.json`);
}

/** 读已提升的基线 */
export function readBaseline(suiteId: string, profileId: string): CampaignReport | undefined {
  return readJson<CampaignReport>(baselineFile(suiteId, profileId));
}

/**
 * 找最近一次匹配 suite/profile 的 campaign 报告。
 * 从 <runtimeDir>/agent-bench/runs/<campaignId>/<profileId>/campaign.json 读取。
 */
export function findLatestCampaign(
  suiteId: string,
  profileId: string,
): { file: string; report: CampaignReport } | undefined {
  const runsRoot = join(BENCH_ROOT, "runs");
  if (!existsSync(runsRoot)) return undefined;
  const found: Array<{ file: string; report: CampaignReport; mtime: number }> = [];
  for (const campaign of readdirSync(runsRoot)) {
    const file = join(runsRoot, campaign, profileId, "campaign.json");
    if (!existsSync(file)) continue;
    const report = readJson<CampaignReport>(file);
    if (!report || report.suiteId !== suiteId || report.profile?.id !== profileId) continue;
    found.push({ file, report, mtime: statSync(file).mtimeMs });
  }
  if (!found.length) return undefined;
  found.sort((a, b) => b.mtime - a.mtime);
  return { file: found[0].file, report: found[0].report };
}

function rateOf(report: CampaignReport, metric: string): number | null {
  return report.metrics.find((m) => m.metric === metric)?.rate ?? null;
}

/**
 * 比较候选与基线。判据与 agent-bench evolve 同构：主指标任一劣化即拒，
 * 至少一项提升才算正向；但这里的「不可比」判定更严（见 APPARATUS_KEYS 注释）。
 */
export function compareCampaigns(baseline: CampaignReport, candidate: CampaignReport): GateVerdict {
  const ids = { baselineCampaignId: baseline.campaignId, candidateCampaignId: candidate.campaignId };

  if (candidate.runs.some((r) => r.status === "invalid")) {
    return { status: "invalid_runs", reason: "候选报告里存在 invalid run，结果不可信", ...ids };
  }
  for (const key of APPARATUS_KEYS) {
    if (baseline.fingerprints[key] !== candidate.fingerprints[key]) {
      return {
        status: "incomparable",
        reason: `${key} fingerprint 与基线不一致，两次结果不可比（评测装置或被测代码变了，请重建基线）`,
        ...ids,
      };
    }
  }
  // 提示词改了 runtimeState 必然变；没变说明候选跑的还是旧提示词，这份证据是假的
  if (baseline.fingerprints.runtimeState === candidate.fingerprints.runtimeState) {
    return {
      status: "not_measured",
      reason: "runtimeState 与基线相同，说明候选提示词并未真正生效，这份回归结果不能作为证据",
      ...ids,
    };
  }

  const deltas: GateVerdict["deltas"] = [];
  let improved = false;
  for (const metric of PRIMARY_METRICS) {
    const before = rateOf(baseline, metric);
    const after = rateOf(candidate, metric);
    // 两侧都没评出（如本形态下某维度恒为 N/A）→ 跳过，不作为拒绝理由
    if (before === null && after === null) {
      deltas.push({ metric, baseline: before, candidate: after, delta: null });
      continue;
    }
    if (before === null || after === null) {
      return {
        status: "incomparable",
        reason: `${metric} 只有一侧评出（基线 ${before}，候选 ${after}），无法判断是否退化`,
        deltas,
        ...ids,
      };
    }
    // hallucination 是「坏声明占比」，方向相反
    const delta = metric === "hallucination" ? before - after : after - before;
    deltas.push({ metric, baseline: before, candidate: after, delta: Number(delta.toFixed(4)) });
    if (delta < 0) {
      return {
        status: "regressed",
        reason: `${metric} 劣化 ${(Math.abs(delta) * 100).toFixed(2)}pp（${before} → ${after}）`,
        deltas,
        ...ids,
      };
    }
    if (delta > 0) improved = true;
  }

  return improved
    ? { status: "pass", reason: "主指标至少一项提升且无一项劣化", deltas, ...ids }
    : { status: "no_improvement", reason: "主指标全部持平，未观测到改进", deltas, ...ids };
}

/** 提案上附着的回归证据 */
export interface RegressionEvidence {
  /** 候选 campaign 报告路径 */
  campaignFile: string;
  /** 被测的提示词内容哈希——把证据绑定到具体文本，防止张冠李戴 */
  promptSha: string;
  status: GateStatus;
  reason: string;
  deltas?: GateVerdict["deltas"];
  measuredAt: string;
}

export function promptSha(text: string): string {
  return createHash("sha256").update(text ?? "").digest("hex");
}

/**
 * 依据一份候选报告产出可附着到提案上的证据。
 * proposedPrompt 必须是提案的 after 原文——promptSha 就是靠它把证据钉死在这段文本上。
 */
export function buildRegressionEvidence(params: {
  agentId: string;
  proposedPrompt: string;
  campaignFile?: string;
}): { evidence?: RegressionEvidence; verdict: GateVerdict } {
  const { suiteId, profileId } = benchTargetOf(params.agentId);
  const baseline = readBaseline(suiteId, profileId);
  if (!baseline) {
    return {
      verdict: {
        status: "missing_baseline",
        reason: `没有 ${suiteId}/${profileId} 的基线，先跑一次回归并 baseline promote`,
      },
    };
  }
  const candidate = params.campaignFile
    ? (() => {
        const report = readJson<CampaignReport>(params.campaignFile!);
        return report ? { file: params.campaignFile!, report } : undefined;
      })()
    : findLatestCampaign(suiteId, profileId);
  if (!candidate) {
    return {
      verdict: { status: "missing_candidate", reason: `找不到 ${suiteId}/${profileId} 的候选回归报告` },
    };
  }
  const verdict = compareCampaigns(baseline, candidate.report);
  return {
    verdict,
    evidence: {
      campaignFile: candidate.file,
      promptSha: promptSha(params.proposedPrompt),
      status: verdict.status,
      reason: verdict.reason,
      deltas: verdict.deltas,
      measuredAt: new Date().toISOString(),
    },
  };
}

/**
 * 校验一条已附着的证据能否放行本次应用。
 * 除了状态本身，还要确认证据绑定的提示词与当前要写入的提示词是同一段文本——
 * 否则「拿 A 版本的回归结果批准 B 版本」这条漏洞会让门禁形同虚设。
 */
export function checkAttachedEvidence(
  evidence: RegressionEvidence | undefined,
  proposedPrompt: string,
): { allow: boolean; reason: string } {
  if (!evidence) {
    return { allow: false, reason: "提案没有附回归结果" };
  }
  if (evidence.promptSha !== promptSha(proposedPrompt)) {
    return {
      allow: false,
      reason: "回归结果对应的提示词与本次要写入的不一致（提案在测完之后被改过），需重新回归",
    };
  }
  if (evidence.status === "pass" || evidence.status === "no_improvement") {
    // no_improvement 放行：门禁的语义是「不退化」而非「必须变好」。
    // 提案可能是为了修一个 case 覆盖不到的问题，持平就是可接受结果。
    return { allow: true, reason: `回归通过（${evidence.status}）：${evidence.reason}` };
  }
  return { allow: false, reason: `回归未通过（${evidence.status}）：${evidence.reason}` };
}
