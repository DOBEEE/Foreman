import { existsSync } from "node:fs";
import { join } from "node:path";
import { listPendingCases } from "../core/case-harvest.js";
import { approveByRef, discardByRef, resolveApproval } from "../bench/approval.js";
import { listPendingUpgrades, qualityCaseCount } from "../bench/upgrade.js";
import { runQualityCampaign } from "../bench/quality-campaign.js";
import { loadRegressionCases } from "../bench/regression.js";
import { runBenchCycle, summarizeCycle } from "../bench/cycle.js";
import { sweepHarvest } from "../core/harvest-sweep.js";
import { config } from "../config/index.js";

/**
 * 一层回归的命令行入口（零 LLM）。
 *
 * 有了周期触发还要这个，是因为「等到周一 20:00」在两个场景下不可接受：
 *   1. 刚接完线要验证链路通不通
 *   2. 用户刚说「这不对」，想立刻把它变成一条永久标准
 *
 * 所有子命令都走与定时任务**同一条**代码路径（runBenchCycle / sweepHarvest），
 * 不另开一份手工流程——两份实现必然漂移，而漂移的那份正好是出事时你依赖的那份。
 */
export const BENCH_HELP = `foreman bench — 一层回归（确定性断言，零 LLM）

用法:
  foreman bench run [<岗位>...]        跑一轮完整周期：采集扫描 → 回归 → 出报告 → 起草二层升级
  foreman bench sweep                 只做采集扫描（看看有什么会被采集，不跑测）
  foreman bench cases                 列出已晋升的 case、待审 case 与待审升级
  foreman bench approve <caseId>      批准（新用例或二层升级，同一个动作）
  foreman bench discard <caseId>      丢弃
  foreman bench quality <岗位>         跑二层评测（四维 LLM 判定，成本高，只在需要时跑）
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export async function runBenchCommand(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;

  if (!action || action === "-h" || action === "--help") {
    console.log(BENCH_HELP);
    return;
  }

  if (action === "sweep") {
    const result = sweepHarvest(config.bench.days);
    console.log(
      `扫了 ${result.scannedRuns} 次执行：${result.negativeFeedback} 条带负反馈，` +
        `${result.contractViolations} 条契约违规`,
    );
    for (const item of result.outcomes) {
      console.log(`- ${item.agentId} ${item.runId}：${item.reason} → ${item.outcome.action}`);
      if (item.outcome.action === "skipped") console.log(`  跳过原因：${item.outcome.reason}`);
    }
    if (!result.outcomes.length) console.log("没有可采集的东西（这是好事）");
    return;
  }

  if (action === "cases") {
    const promoted = loadRegressionCases();
    console.log(`已晋升 ${promoted.length} 条：`);
    for (const item of promoted) {
      const tier2 = qualityCaseCount(item.agentId) > 0 && existsSync(join(item.root, "oracle", "requirements.json"));
      console.log(
        `- ${item.agentId}/${item.caseId}（${item.assertions.length} 条断言，来源 ${item.source ?? "?"}` +
          `${tier2 ? "，已升二层" : ""}）`,
      );
    }
    const pending = listPendingCases();
    console.log(`\n待审新用例 ${pending.length} 条：`);
    for (const item of pending) {
      console.log(
        `- ${item.agentId}/${item.caseId}（复现 ${item.provenance.reproductions} 次，来源 ${item.source}）` +
          (item.provenance.feedbackText ? `\n  用户原话：${item.provenance.feedbackText}` : ""),
      );
    }
    const upgrades = listPendingUpgrades();
    console.log(`\n待审二层升级 ${upgrades.length} 条：`);
    for (const item of upgrades) {
      console.log(`- ${item.agentId}/${item.caseId}（${item.facts.length} 条事实、${item.conventions.length} 条规约）`);
      for (const fact of item.facts) console.log(`  · ${fact.statement}\n    引自 ${fact.evidence[0].document}`);
      if (item.rejected.length) console.log(`  机器已拦掉 ${item.rejected.length} 条引文对不上的`);
    }
    if (pending.length || upgrades.length) console.log(`\n批准：foreman bench approve <caseId>`);
    return;
  }

  if (action === "approve" || action === "discard") {
    const ref = rest[0];
    if (!ref) fail(`缺少 caseId。用法见 foreman bench --help`);
    const found = resolveApproval(ref);
    if (!found) fail(`没找到待审项 ${ref}。跑 foreman bench cases 看清单`);
    const result = action === "approve" ? approveByRef(found) : discardByRef(found);
    console.log(`[${found.kind === "case" ? "新用例" : "二层升级"}] ${result.message}`);
    if (!result.ok) process.exit(1);
    return;
  }

  if (action === "quality") {
    const agentId = rest[0];
    if (!agentId) fail("缺少岗位名。用法见 foreman bench --help");
    const outcome = await runQualityCampaign({ agentId });
    if (!outcome.ok) fail(outcome.message);
    console.log(outcome.message);
    for (const metric of outcome.report!.metrics) {
      const spread = (metric.details as { spread?: number | null } | undefined)?.spread;
      console.log(
        `- ${metric.metric}: ${metric.status}` +
          (metric.rate === null ? "" : ` ${metric.rate}（${metric.numerator}/${metric.denominator}）`) +
          (spread === null || spread === undefined ? "" : `，离散度 ${spread}`),
      );
    }
    return;
  }

  if (action === "run") {
    const locked = await runBenchCycle({
      ...(rest.length ? { agentIds: rest } : {}),
      days: config.bench.days,
    });
    if (!locked.ok) fail(locked.message);
    const result = locked.value!;
    console.log(
      `采集扫描：${result.sweep.scannedRuns} 次执行，` +
        `${result.sweep.outcomes.length} 条命中采集条件`,
    );
    if (result.skipped.length) {
      console.log(`跳过（没有 case）：${result.skipped.join("、")}`);
    }
    for (const item of result.reports) {
      const s = item.report.summary;
      console.log(
        `\n${item.agentId}：${s.passed} 通过 / ${s.failed} 失败 / ${s.invalid} 判不成（共 ${s.total}）` +
          `\n  报告：${item.markdownFile}`,
      );
      for (const finding of item.findings) {
        console.log(`  - ${finding.id} [${finding.category}] → ${finding.suggestedOwner}`);
      }
    }
    if (result.pending.length) {
      console.log(`\n${result.pending.length} 条 case 待批准（foreman bench cases 看详情）`);
    }
    console.log(`\n${summarizeCycle(result)}`);
    return;
  }

  fail(`未知的 bench 子命令：${action}\n\n${BENCH_HELP}`);
}
