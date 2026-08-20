import { existsSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { harvestRoots } from "../core/case-harvest.js";
import type { RegressionReport } from "./regression.js";

/**
 * 逐 case 的历史台账。
 *
 * 两个用途：
 *   1. 判「这条 case 稳不稳」—— 二层探针必须是连续全绿的 case，否则分数动了
 *      没法归因是提示词变了还是这条 case 自己在抖
 *   2. 排查时回答「这条 case 是从哪一轮开始红的」。报告只有 latest，
 *      而退化往往是几轮前埋下的
 *
 * 刻意用 JSONL 追加而不是维护一份聚合状态：追加没有并发写冲突（多实例各写一行都对），
 * 而聚合状态需要读-改-写，两个实例同时跑就会互相覆盖。
 */

export interface HistoryEntry {
  campaignId: string;
  time: string;
  agentId: string;
  caseId: string;
  status: "passed" | "failed" | "invalid";
  /** 失败的计分断言 id，供「从哪轮开始红」定位到具体断言 */
  failedAssertions?: string[];
}

function historyFile(): string {
  return join(harvestRoots().root, "history.jsonl");
}

export function appendHistory(report: RegressionReport): void {
  const lines = report.cases.map((item) => {
    const failed = item.assertions
      .filter((a) => a.scoring?.includes("completion") && a.deterministicStatus !== "pass" && a.deterministicStatus !== "not_applicable")
      .map((a) => a.id);
    return JSON.stringify({
      campaignId: report.campaignId,
      time: report.endedAt,
      agentId: item.agentId,
      caseId: item.caseId,
      status: item.status,
      ...(failed.length ? { failedAssertions: failed } : {}),
    } satisfies HistoryEntry);
  });
  if (!lines.length) return;
  const file = historyFile();
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${lines.join("\n")}\n`, "utf-8");
}

export function readHistory(caseId?: string): HistoryEntry[] {
  const file = historyFile();
  if (!existsSync(file)) return [];
  const out: HistoryEntry[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (!caseId || entry.caseId === caseId) out.push(entry);
    } catch {
      // 追加写的最后一行可能不完整
    }
  }
  return out;
}

/**
 * 最近连续全绿的轮数。
 *
 * `invalid` **打断**连续计数而不是被跳过：一轮判不成就等于那轮没有证据，
 * 拿「中间几轮没测但两头是绿的」当连续通过，是在用缺失数据充当证据。
 */
export function consecutivePasses(caseId: string): number {
  const entries = readHistory(caseId);
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].status !== "passed") break;
    count += 1;
  }
  return count;
}

/** 这条 case 从哪一轮开始不再通过（用于排查，返回最早的那次连续失败） */
export function regressedSince(caseId: string): HistoryEntry | undefined {
  const entries = readHistory(caseId);
  let found: HistoryEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].status === "passed") break;
    found = entries[i];
  }
  return found;
}
