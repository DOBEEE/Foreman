import { withBenchLock } from "../core/bench-lock.js";
import { listPendingCases } from "../core/case-harvest.js";
import { sweepHarvest, type SweepResult } from "../core/harvest-sweep.js";
import { loadRegressionCases, runRegression, type RegressionReport } from "./regression.js";
import { writeRegressionReport } from "./report.js";
import { appendHistory } from "./history.js";
import { draftQualityUpgrade, upgradeDecision } from "./upgrade.js";
import { routeOf, type Finding } from "./attribution.js";

/**
 * 评测周期的唯一入口。
 *
 * 顺序是有讲究的：先采集再跑。反过来的话，本周新出现的问题要等到下周才被测到，
 * 而「这问题不会再犯」的保证就迟一整个周期。
 *
 * **不给每个岗位排期**。触发是事件驱动的：
 *   - 有负反馈或契约违规被采集成 case（本函数第一步就在判这个）
 *   - 有提示词提案待批（走 gate tier1，不走这里）
 * 没有 case 的岗位直接跳过 —— 为一个没攒下任何问题的岗位跑评测，
 * 除了烧钱什么都得不到。
 */

export interface BenchCycleResult {
  sweep: SweepResult;
  /** 有 case 可跑的岗位的报告 */
  reports: Array<{ agentId: string; report: RegressionReport; markdownFile: string; findings: Finding[] }>;
  /** 没有 case、本次跳过的岗位 */
  skipped: string[];
  /** 待人工批准的 case（周一卡片要用） */
  pending: Array<{ agentId: string; caseId: string; reproductions: number; feedbackText?: string }>;
  /** 本轮尝试起草的二层升级（ok=false 时 detail 是没起草的原因，多数是「条件没到」以外的真问题） */
  drafted: Array<{ agentId: string; caseId: string; ok: boolean; detail: string }>;
}

/**
 * 跑一个完整周期。整段在评测锁内：候选提示词的挂/摘、报告写入都不能与另一次评测交错。
 *
 * @param agentIds 限定岗位；缺省为「所有有已晋升 case 的岗位」
 */
export async function runBenchCycle(params: { agentIds?: string[]; days?: number } = {}) {
  return withBenchLock(async (): Promise<BenchCycleResult> => {
    const sweep = sweepHarvest(params.days);
    const pending = listPendingCases().map((item) => ({
      agentId: item.agentId,
      caseId: item.caseId,
      reproductions: item.provenance.reproductions,
      ...(item.provenance.feedbackText ? { feedbackText: item.provenance.feedbackText } : {}),
    }));

    const all = loadRegressionCases();
    const targets = params.agentIds ?? [...new Set(all.map((item) => item.agentId))];
    const reports: BenchCycleResult["reports"] = [];
    const skipped: string[] = [];
    const drafted: BenchCycleResult["drafted"] = [];

    for (const agentId of targets) {
      const cases = all.filter((item) => item.agentId === agentId);
      if (!cases.length) {
        skipped.push(agentId);
        continue;
      }
      const report = await runRegression({ agentId, cases });
      // 台账先落：后面的升级判定要读连续全绿轮数，包含本轮
      appendHistory(report);
      const { markdownFile, findings } = writeRegressionReport({
        report,
        pending: pending.filter((item) => item.agentId === agentId),
      });
      reports.push({ agentId, report, markdownFile, findings });

      // 二层升级起草：只对本轮通过的 case 尝试，且由 upgradeDecision 决定该不该动
      for (const item of report.cases) {
        const benchmarkCase = cases.find((c) => c.caseId === item.caseId);
        if (!benchmarkCase) continue;
        const decision = upgradeDecision({ benchmarkCase, result: item });
        if (!decision.eligible) continue;
        const outcome = await draftQualityUpgrade({
          benchmarkCase,
          transcriptFile: item.execution.transcriptFile,
        });
        drafted.push({
          agentId,
          caseId: item.caseId,
          ok: outcome.ok,
          detail: outcome.ok
            ? `${outcome.upgrade.facts.length} 条事实待确认`
            : outcome.reason,
        });
      }
    }

    return { sweep, reports, skipped, pending, drafted };
  });
}

/** 一行摘要，给日志与卡片用 */
export function summarizeCycle(result: BenchCycleResult): string {
  const parts: string[] = [];
  for (const item of result.reports) {
    const s = item.report.summary;
    // 只报优化师能处理的 finding 数：把 discard 类算进去会让「问题很多」的印象失真
    const actionable = item.findings.filter((f) => routeOf(f.category) !== "discard").length;
    parts.push(`${item.agentId} ${s.passed}/${s.total} 通过${actionable ? `，${actionable} 条待优化` : ""}`);
  }
  if (result.pending.length) parts.push(`${result.pending.length} 条 case 待批准`);
  const draftedOk = result.drafted.filter((item) => item.ok).length;
  if (draftedOk) parts.push(`${draftedOk} 条可升为二层待确认`);
  if (!parts.length) return "本次没有可跑的回归 case";
  return parts.join("；");
}
