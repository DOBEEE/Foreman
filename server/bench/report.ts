import { join } from "node:path";
import { LOG_DIR } from "../core/logger.js";
import { ensureDir, writeJson } from "./files.js";
import { writeFileSync } from "node:fs";
import { attributeAssertions, routeOf, type Finding, type FindingRoute } from "./attribution.js";
import type { RegressionReport } from "./regression.js";

/**
 * 一层回归报告（markdown）。
 *
 * 写给**优化师**读，所以刻意只给两样东西：失败断言的「要求 vs 实际」，和它该由谁改。
 * 明确不给的是任何聚合比率 —— 看到「completion 0.67」改不了任何东西，
 * 而让优化师盯着一个数字写提案，就是在训练它优化指标而不是优化行为。
 *
 * 也给人读：待审 case 与 discard 类问题都要露出来，否则采集器会悄悄攒下一堆
 * 没人看过的标准，或者基建故障被反复归因到员工头上。
 */

/** 报告根目录：<repo>/logs/bench-reports/<agentId>/ */
export function reportDir(agentId: string): string {
  return join(LOG_DIR, "bench-reports", agentId);
}

const ROUTE_TITLE: Record<FindingRoute, string> = {
  prompt: "改提示词 / 规约（优化师处理）",
  knowledge: "补知识库（优化师处理）",
  code: "要人改代码或工具（不是提示词能修的）",
  discard: "评测侧 / 基建故障（不进优化循环）",
};

function findingLines(findings: Finding[]): string[] {
  const lines: string[] = [];
  const byRoute = new Map<FindingRoute, Finding[]>();
  for (const finding of findings) {
    const route = routeOf(finding.category);
    byRoute.set(route, [...(byRoute.get(route) ?? []), finding]);
  }
  // 顺序固定：优化师该先看自己能修的
  for (const route of ["prompt", "knowledge", "code", "discard"] as FindingRoute[]) {
    const items = byRoute.get(route);
    if (!items?.length) continue;
    lines.push("", `### ${ROUTE_TITLE[route]}（${items.length}）`, "");
    for (const item of items) {
      lines.push(`- \`${item.id}\` category=${item.category}`);
      lines.push(`  - ${item.evidence}`);
    }
  }
  return lines;
}

export interface PendingCaseBrief {
  agentId: string;
  caseId: string;
  reproductions: number;
  feedbackText?: string;
}

export function renderRegressionReport(params: {
  report: RegressionReport;
  findings: Finding[];
  pending?: PendingCaseBrief[];
}): string {
  const { report, findings, pending = [] } = params;
  const s = report.summary;
  const lines: string[] = [
    `# 一层回归报告 — ${report.agentId}`,
    "",
    `- 时间：${report.startedAt} → ${report.endedAt}`,
    `- case 集合指纹：\`${report.caseSet.slice(0, 16)}\``,
    `- 结果：${s.passed} 通过 / ${s.failed} 失败 / ${s.invalid} 判不成（共 ${s.total}）`,
    "",
    "> 这一层是零 LLM 的确定性断言，判据是人批准过的绝对标准，没有基线也没有容差。",
    "> 失败即「这个问题又犯了」，不需要再跟任何历史分数比较。",
  ];

  const failed = report.cases.filter((item) => item.status === "failed");
  if (failed.length) {
    lines.push("", "## 失败的 case", "");
    for (const item of failed) {
      lines.push(`### ${item.caseId}${item.source ? `（来源：${item.source}）` : ""}`, "");
      for (const assertion of item.assertions) {
        if (!assertion.scoring?.includes("completion")) continue;
        if (assertion.deterministicStatus === "pass" || assertion.deterministicStatus === "not_applicable") continue;
        lines.push(`- \`${assertion.id}\` [${assertion.type}] ${assertion.deterministicStatus}`);
        if (assertion.objective) lines.push(`  - 要求：${assertion.objective}`);
        if (assertion.detail) lines.push(`  - 实际：${assertion.detail}`);
      }
      lines.push("", `轨迹：\`${item.execution.transcriptFile}\``, "");
    }
  }

  const invalid = report.cases.filter((item) => item.status === "invalid");
  if (invalid.length) {
    lines.push("", "## 判不成的 case（不指向员工行为）", "");
    for (const item of invalid) lines.push(`- ${item.caseId}：${item.invalidReason ?? "原因未记录"}`);
  }

  if (findings.length) {
    lines.push("", "## 归因", ...findingLines(findings));
  } else {
    lines.push("", "## 归因", "", "本轮无失败断言，没有可归因的东西。");
  }

  if (pending.length) {
    lines.push(
      "",
      "## 待人工批准的 case",
      "",
      "这些是采集到、复现已达门槛、但还没进回归套件的标准。**批准前请扫一眼断言写得对不对**——",
      "断言写错了，员工会为一条不该存在的标准反复被改，而且它会一直留在套件里。",
      "",
    );
    for (const item of pending) {
      lines.push(`- \`${item.agentId}/${item.caseId}\`（复现 ${item.reproductions} 次）`);
      if (item.feedbackText) lines.push(`  - 用户原话：${item.feedbackText}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** 落盘 latest.md + 带时间戳的历史副本 + 结构化 json */
export function writeRegressionReport(params: {
  report: RegressionReport;
  pending?: PendingCaseBrief[];
}): { markdownFile: string; findings: Finding[] } {
  const findings = attributeAssertions(params.report);
  const dir = reportDir(params.report.agentId);
  ensureDir(dir);
  const markdown = renderRegressionReport({ report: params.report, findings, pending: params.pending });
  const markdownFile = join(dir, "latest.md");
  writeFileSync(markdownFile, markdown, "utf-8");
  writeFileSync(join(dir, `${params.report.campaignId}.md`), markdown, "utf-8");
  // 结构化副本给门禁/仪表盘用：markdown 是给人和 LLM 读的，不该被程序解析
  writeJson(join(dir, "latest.json"), { schemaVersion: 1, report: params.report, findings });
  return { markdownFile, findings };
}
