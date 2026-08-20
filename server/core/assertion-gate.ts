import { createHash } from "node:crypto";
import type { RegressionReport } from "../bench/regression.js";
import type { DeterministicStatus } from "../bench/trace-assertions.js";

/**
 * 一层回归的门禁判据（零 LLM）。
 *
 * 与 regression-gate.ts 的分工：那边比的是二层四维 LLM 分数（「是不是变笨了」），
 * 判据是相对的、要基线和噪声带；这边比的是确定性断言的**翻转**，判据是绝对的：
 *
 *   判据 A：提案声称修的断言必须 fail → pass。不翻转就是没修，直接拒。
 *           这是因果而不是相关 —— 比「某个比率涨了」强一个数量级。
 *   判据 B：其余任何断言都不许 pass → 非 pass。这是「不会再犯」的机器保证。
 *
 * 两条都不需要 LLM，所以可以离线复算，也不存在「裁判与被测同源」的问题。
 *
 * 三个刻意的严格处：
 *   1. caseSet 不同即不可比。否则「删掉那条过不了的 case」就是最省力的过闸方式
 *   2. 候选轮出现 invalid case 即拒。invalid 意味着断言压根没判，
 *      当成「没退化」就是把基础设施故障变成放行通道
 *   3. pass → not_applicable 也算破坏。断言从「通过」变成「不再被检查」，
 *      正是 DGM 里实证过的那种 reward hacking 形态（删掉检测所依赖的标记）
 */

export interface AssertionSnapshot {
  campaignId: string;
  /** case 集合指纹：两轮必须完全一致才谈得上比较 */
  caseSet: string;
  /** `<caseId>::<assertionId>` → 判定结果 */
  statuses: Record<string, DeterministicStatus>;
  /** 因 case/环境问题没判成的 case */
  invalidCases: string[];
}

export interface AssertionTarget {
  caseId: string;
  assertionId: string;
}

export type AssertionGateStatus =
  | "pass"
  | "not_fixed"
  | "broke_others"
  | "incomparable"
  | "invalid_runs"
  | "no_target";

export interface AssertionVerdict {
  status: AssertionGateStatus;
  reason: string;
  /** 由失败转通过的断言 */
  fixed: string[];
  /** 由通过转失败（或转为不再被检查）的断言 */
  broken: string[];
  /** 声称要修但仍未通过的断言 */
  stillFailing: string[];
}

export function assertionKey(caseId: string, assertionId: string): string {
  return `${caseId}::${assertionId}`;
}

/** 只快照参与 completion 计分的断言：没进分母的东西改了也不体现在判据里 */
export function snapshotAssertions(report: RegressionReport): AssertionSnapshot {
  const statuses: Record<string, DeterministicStatus> = {};
  const invalidCases: string[] = [];
  for (const item of report.cases) {
    if (item.status === "invalid") {
      invalidCases.push(item.caseId);
      continue;
    }
    for (const assertion of item.assertions) {
      if (!assertion.scoring?.includes("completion")) continue;
      statuses[assertionKey(item.caseId, assertion.id)] = assertion.deterministicStatus;
    }
  }
  return { campaignId: report.campaignId, caseSet: report.caseSet, statuses, invalidCases };
}

export function compareAssertionSnapshots(
  before: AssertionSnapshot,
  after: AssertionSnapshot,
  targets: AssertionTarget[],
): AssertionVerdict {
  const empty = { fixed: [], broken: [], stillFailing: [] };

  if (before.caseSet !== after.caseSet) {
    return {
      status: "incomparable",
      reason: "两轮的 case 集合不同，不可比（case 被增删过；删掉过不了的 case 不是修好了）",
      ...empty,
    };
  }
  if (after.invalidCases.length) {
    return {
      status: "invalid_runs",
      reason: `候选轮有 ${after.invalidCases.length} 个 case 判不成（${after.invalidCases.join(", ")}），断言未被真正验证`,
      ...empty,
    };
  }
  if (before.invalidCases.length) {
    return {
      status: "invalid_runs",
      reason: `基线轮有 ${before.invalidCases.length} 个 case 判不成（${before.invalidCases.join(", ")}），没有可比的起点`,
      ...empty,
    };
  }

  const fixed: string[] = [];
  const broken: string[] = [];
  for (const [key, previous] of Object.entries(before.statuses)) {
    const current = after.statuses[key];
    if (current === undefined) {
      // 断言消失了。caseSet 相同却少了断言，只能是判定过程出了问题
      broken.push(`${key}（断言在候选轮消失）`);
      continue;
    }
    if (previous !== "pass" && current === "pass") fixed.push(key);
    if (previous === "pass" && current !== "pass") {
      broken.push(current === "not_applicable" ? `${key}（由通过变为不再被检查）` : key);
    }
  }

  if (broken.length) {
    return {
      status: "broke_others",
      reason: `${broken.length} 条原本通过的断言被弄坏：${broken.slice(0, 5).join(", ")}`,
      fixed,
      broken,
      stillFailing: [],
    };
  }

  if (!targets.length) {
    // 没声明修哪条 = 无法验证它到底修了什么。此时只能给出「没破坏别的」这一半结论
    return {
      status: "no_target",
      reason: "提案没声明要修哪条断言，只能确认未破坏既有断言，无法确认它修好了什么",
      fixed,
      broken,
      stillFailing: [],
    };
  }

  const stillFailing: string[] = [];
  const staleTargets: string[] = [];
  for (const target of targets) {
    const key = assertionKey(target.caseId, target.assertionId);
    const previous = before.statuses[key];
    if (previous === undefined) {
      staleTargets.push(`${key}（不在本次 case 集合里）`);
      continue;
    }
    // 改动前就已通过：这条提案的依据不成立，别让它拿一条本来就绿的断言当业绩
    if (previous === "pass") staleTargets.push(`${key}（改动前就已通过）`);
    else if (after.statuses[key] !== "pass") stillFailing.push(key);
  }

  if (staleTargets.length) {
    return {
      status: "not_fixed",
      reason: `提案声称的目标断言依据不成立：${staleTargets.join(", ")}`,
      fixed,
      broken,
      stillFailing,
    };
  }
  if (stillFailing.length) {
    return {
      status: "not_fixed",
      reason: `目标断言仍未通过：${stillFailing.join(", ")}，说明这次改动没有真的修掉问题`,
      fixed,
      broken,
      stillFailing,
    };
  }

  return {
    status: "pass",
    reason: `目标断言 ${targets.length} 条全部由失败转通过，且没有弄坏任何既有断言`,
    fixed,
    broken,
    stillFailing,
  };
}

/** 附着到提案上的一层证据 */
export interface AssertionEvidence {
  status: AssertionGateStatus;
  reason: string;
  /** 被测的提示词内容哈希：把证据钉死在这段文本上，防止「拿 A 的结果批准 B」 */
  promptSha: string;
  baselineCampaignId: string;
  candidateCampaignId: string;
  caseSet: string;
  targets: AssertionTarget[];
  fixed: string[];
  broken: string[];
  stillFailing: string[];
  measuredAt: string;
}

export function assertionPromptSha(text: string): string {
  return createHash("sha256").update(text ?? "").digest("hex");
}

export function buildAssertionEvidence(params: {
  proposedPrompt: string;
  before: AssertionSnapshot;
  after: AssertionSnapshot;
  targets: AssertionTarget[];
}): { evidence: AssertionEvidence; verdict: AssertionVerdict } {
  const verdict = compareAssertionSnapshots(params.before, params.after, params.targets);
  return {
    verdict,
    evidence: {
      status: verdict.status,
      reason: verdict.reason,
      promptSha: assertionPromptSha(params.proposedPrompt),
      baselineCampaignId: params.before.campaignId,
      candidateCampaignId: params.after.campaignId,
      caseSet: params.after.caseSet,
      targets: params.targets,
      fixed: verdict.fixed,
      broken: verdict.broken,
      stillFailing: verdict.stillFailing,
      measuredAt: new Date().toISOString(),
    },
  };
}

/**
 * 校验一条已附着的一层证据能否放行本次应用。
 *
 * `no_target` 刻意**不放行**：它意味着我们只知道「没弄坏别的」，不知道它修好了什么。
 * 放行等于允许一份无法验证效果的改动生效，那正是这套门禁要挡的东西。
 */
export function checkAssertionEvidence(
  evidence: AssertionEvidence | undefined,
  proposedPrompt: string,
): { allow: boolean; reason: string } {
  if (!evidence) return { allow: false, reason: "提案没有附一层回归证据" };
  if (evidence.promptSha !== assertionPromptSha(proposedPrompt)) {
    return {
      allow: false,
      reason: "一层证据对应的提示词与本次要写入的不一致（提案在测完之后被改过），需重跑回归",
    };
  }
  if (evidence.status === "pass") {
    return { allow: true, reason: `一层回归通过：${evidence.reason}` };
  }
  return { allow: false, reason: `一层回归未通过（${evidence.status}）：${evidence.reason}` };
}
