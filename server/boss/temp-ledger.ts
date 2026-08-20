import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import { truncate } from "../core/logger.js";
import type { Task } from "./types.js";

/**
 * 临时工台账：**持久累加器**，不是滚动日志。
 *
 * 释放人，保留记录。同类需求可能相隔两周才出现第二次，按「最近 N 天」去看永远
 * 凑不满一簇、模式永远发现不了；所以记录跨天累加，hr 每次看的是**全部 pending**。
 *
 * 上下文不随台账线性增长的办法是**计数由代码做**（按 capabilitySlug 精确分组），
 * 只把「不同能力域 + 次数 + 各组摘要」交给 hr——规模由能力域个数决定，与总记录数无关。
 * 近义写法（csv-summarize / table-aggregate）代码分不了，那一层留给 hr 语义合并。
 */

export interface LedgerEntry {
  id: string;
  ts: number;
  tempId: string;
  /** 能力域原文（hr 做语义合并的依据） */
  capability: string;
  /** 归一化键：代码按它精确分组 */
  capabilitySlug: string;
  /** 这次干的活 */
  hiredFor: string;
  taskId: string;
  chatId: string;
  hiredBy: "boss" | "hr";
  /** 归档 profile 路径 → hr 设计通用岗位时能回看当时那份提示词 */
  archivedSpec?: string;
  /**
   * 干得顺不顺的确定性证据（快照，不依赖 Task 还在）：
   * reviewRounds>0 说明返工过、bossAssists>0 说明它自己问不清。
   */
  effectiveness: {
    state: string;
    reviewRounds: number;
    bossAssists: number;
    autoContinues: number;
    reassigns: number;
    resultSummary?: string;
  };
  /**
   * pending  → 待归纳
   * proposed → 已进某条建岗提案（**不删**：用户驳回后证据还得在）
   * consumed → 提案已批准，正式岗位已落盘
   * declined → 用户驳回，不再参与聚类（避免拿同一批记录反复烦人）
   */
  status: "pending" | "proposed" | "consumed" | "declined";
  proposedIn?: string;
}

function ledgerPath(): string {
  mkdirSync(config.runtimeDir, { recursive: true });
  return join(config.runtimeDir, "temp-ledger.jsonl");
}

function readAll(): LedgerEntry[] {
  const file = ledgerPath();
  if (!existsSync(file)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (e?.id && e.capabilitySlug) out.push(e);
    } catch {
      /* 坏行跳过：台账是只追加文件，一行坏了不该毁掉全部证据 */
    }
  }
  return out;
}

/** 全量重写（状态流转与剪枝用）。台账体量在千行级，整写比就地改行简单可靠得多 */
function writeAll(entries: LedgerEntry[]): void {
  writeFileSync(ledgerPath(), entries.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf-8");
}

export function listLedger(status?: LedgerEntry["status"]): LedgerEntry[] {
  const all = readAll();
  return status ? all.filter((e) => e.status === status) : all;
}

/** 释放临时工时记一行。task 缺失（崩溃恢复等）时只落 profile 那部分 */
export function recordRelease(input: {
  tempId: string;
  capability: string;
  capabilitySlug: string;
  hiredFor: string;
  taskId: string;
  chatId: string;
  hiredBy: "boss" | "hr";
  archivedSpec?: string;
  task?: Task;
}): LedgerEntry {
  const t = input.task;
  const entry: LedgerEntry = {
    id: `tl-${Date.now().toString(36)}-${input.tempId}`,
    ts: Date.now(),
    tempId: input.tempId,
    capability: input.capability,
    capabilitySlug: input.capabilitySlug,
    hiredFor: String(truncate(input.hiredFor, 500)),
    taskId: input.taskId,
    chatId: input.chatId,
    hiredBy: input.hiredBy,
    ...(input.archivedSpec ? { archivedSpec: input.archivedSpec } : {}),
    effectiveness: {
      state: t?.state ?? "unknown",
      reviewRounds: t?.reviewRounds ?? 0,
      bossAssists: t?.bossAssists ?? 0,
      autoContinues: t?.autoContinues ?? 0,
      reassigns: t?.reassigns ?? 0,
      ...(t?.result || t?.error
        ? { resultSummary: String(truncate((t.result ?? t.error ?? "").replace(/\s+/g, " "), 300)) }
        : {}),
    },
    status: "pending",
  };
  try {
    appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.warn("[temp] 写台账失败:", error);
  }
  return entry;
}

export interface Cluster {
  capabilitySlug: string;
  /** 能力域原文（取最近一条的写法） */
  capability: string;
  count: number;
  entries: LedgerEntry[];
}

/**
 * 按 slug 聚合 pending 记录，次数从多到少。
 * declined / proposed / consumed 都不参与——已经问过或已经解决的，不该再攒进同一簇。
 */
export function clusterPending(): Cluster[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of listLedger("pending")) {
    const list = groups.get(e.capabilitySlug);
    if (list) list.push(e);
    else groups.set(e.capabilitySlug, [e]);
  }
  return [...groups.entries()]
    .map(([capabilitySlug, entries]) => ({
      capabilitySlug,
      capability: entries[entries.length - 1].capability,
      count: entries.length,
      entries,
    }))
    .sort((a, b) => b.count - a.count);
}

/** 够阈值的簇（归纳闸门用） */
export function ripeClusters(minCluster = config.consolidation.minCluster): Cluster[] {
  return clusterPending().filter((c) => c.count >= minCluster);
}

/**
 * 交给 hr 的聚合摘要：体积由**不同能力域个数**决定，与总记录数无关。
 * 只给它做语义判断需要的东西（能力域写法、次数、每次干了什么、顺不顺、去哪找原提示词）。
 */
export function clusterDigest(clusters: Cluster[]): string {
  return clusters
    .map((c) => {
      const rows = c.entries.map((e) => {
        const eff = e.effectiveness;
        const flags = [
          eff.state !== "done" ? `结局 ${eff.state}` : undefined,
          eff.reviewRounds > 0 ? `返工 ${eff.reviewRounds} 轮` : undefined,
          eff.bossAssists > 0 ? `主管代答 ${eff.bossAssists} 次` : undefined,
        ].filter(Boolean);
        return [
          `  - 台账 \`${e.id}\`｜任务 #${e.taskId}｜临时工 ${e.tempId}`,
          `    干的活：${e.hiredFor}`,
          flags.length ? `    执行情况：${flags.join("、")}` : "    执行情况：一次通过",
          e.archivedSpec ? `    当时的提示词：${e.archivedSpec}` : undefined,
        ]
          .filter(Boolean)
          .join("\n");
      });
      return [`### 能力域「${c.capability}」（slug ${c.capabilitySlug}，共 ${c.count} 次）`, ...rows].join(
        "\n",
      );
    })
    .join("\n\n");
}

/** 标记这些记录已进某条提案（**不删**，用户驳回后证据还得在） */
export function markProposed(ids: string[], proposalId: string): void {
  const set = new Set(ids);
  writeAll(
    readAll().map((e) =>
      set.has(e.id) && e.status === "pending"
        ? { ...e, status: "proposed" as const, proposedIn: proposalId }
        : e,
    ),
  );
}

/** 提案批准：这批证据已经变成正式岗位，可以退场了 */
export function markConsumed(ids: string[]): LedgerEntry[] {
  const set = new Set(ids);
  const all = readAll();
  const hit = all.filter((e) => set.has(e.id));
  writeAll(all.map((e) => (set.has(e.id) ? { ...e, status: "consumed" as const } : e)));
  return hit;
}

/**
 * 提案驳回：标 declined 而不是删。
 * 删了用户驳回后证据就没了，同一个模式要从零重攒；而 declined 又保证不会拿同一批
 * 记录反复去烦用户——真正持续存在的需求会靠**新产生的**记录再次凑够阈值。
 */
export function markDeclined(ids: string[]): void {
  const set = new Set(ids);
  writeAll(readAll().map((e) => (set.has(e.id) ? { ...e, status: "declined" as const } : e)));
}

/** 某条提案关联的台账 id（批准/驳回时按提案号反查，不必让提案自己存全量） */
export function ledgerIdsOfProposal(proposalId: string): string[] {
  return readAll()
    .filter((e) => e.proposedIn === proposalId)
    .map((e) => e.id);
}

/**
 * 兜底剪枝：pending 超龄且所在能力域始终没凑够阈值 → 清掉（真一次性需求不该永久占位）。
 * 返回被清掉的归档路径，供调用方连带清理归档文件——归档必须**跟着台账走**，不能先删。
 */
export function pruneLedger(now = Date.now()): string[] {
  const maxAge = config.consolidation.pruneDays * 24 * 3600 * 1000;
  const all = readAll();
  const pendingCount = new Map<string, number>();
  for (const e of all) {
    if (e.status !== "pending") continue;
    pendingCount.set(e.capabilitySlug, (pendingCount.get(e.capabilitySlug) ?? 0) + 1);
  }
  const dropped: string[] = [];
  const kept = all.filter((e) => {
    const stale =
      e.status === "pending" &&
      now - e.ts > maxAge &&
      (pendingCount.get(e.capabilitySlug) ?? 0) < config.consolidation.minCluster;
    if (stale && e.archivedSpec) dropped.push(e.archivedSpec);
    return !stale;
  });
  if (kept.length !== all.length) writeAll(kept);
  return dropped;
}
