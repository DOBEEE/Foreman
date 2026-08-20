import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";

/**
 * 任务归档（长期保存，**不设 TTL**）。
 *
 * 补的是这个缺口：任务终态此前散在三处，谁都查不全历史——
 * - `boss/<chatId>.json`：活数据，按 chat 分片、每次整文件重写，只有 boss 侧读；
 * - `workbench/<agent>/<chatId>.jsonl`：只按 `agent × chat`，60 天就清；
 * - `logs/`：被敏感路径规则拦掉，声明了 readRoots 的岗位根本读不到。
 * 于是「三个月前那件活当时怎么结的」这种问题，员工和 boss 都答不上来。
 *
 * 三层分工里它是**档案**（notes 原料 → workbench 工作记忆 → memory 资产，这是第四层）：
 * 不参与蒸馏、不塞满上下文，只保证「问得出来就查得到」。
 *
 * 为什么按月分片 jsonl 而不是 sqlite：
 * - append 天然并发安全（O_APPEND 每行写入原子），多个 run 同时收尾不会互相覆盖；
 * - 本仓库目前零 DB 依赖，加一个引擎要连带处理备份、迁移、并发与损坏恢复；
 * - 按月分片让「最近 N 天」只读一两个文件，不必扫全量。
 * 真到查询量瓶颈时，在归档旁边建索引或换引擎都迁得动——数据是纯文本 jsonl。
 */
export const ARCHIVE_ROOT = join(config.runtimeDir, "archive", "tasks");

/**
 * 单条记录的字段截断上限。
 * 归档要能被 grep、被整月读回，一条动辄几 KB 的 conclusion 会让「读最近一个月」变成读几十兆。
 * 细节本来就不在这里看——归档存的是「当时怎么结的」，原文在 trace 与笔记里。
 */
const FIELD_MAX = 600;
const TITLE_MAX = 120;

export interface TaskArchiveRecord {
  taskId: string;
  chatId: string;
  /** 落档时刻（epoch ms） */
  at: number;
  state: "done" | "failed" | "cancelled";
  agentName: string;
  /** 归属类别：临时工的记录要能与正式成员分开统计（对齐 logger 的 AgentKind） */
  agentKind?: "builtin" | "employee" | "temp";
  channel?: string;
  /** 任务在说什么（brief/prompt 首行） */
  title: string;
  /** report_task_done 的结构化字段（cannot_complete / 没交卷时可能缺） */
  conclusion?: string;
  deliverables?: string;
  verification?: string;
  risks?: string;
  /** 关键决策与理由：日志里推不出来的那部分，档案里最值钱的一列 */
  decisions?: string;
  /** 没交卷就失败时结论只剩报错 */
  error?: string;
  /** 验收标准（当时判「算不算做完」的依据） */
  acceptance?: string;
  /** 改派次数：>0 说明这活换过人，回看派工质量时是硬信号 */
  reassigns?: number;
  /** 当时的随手笔记路径，需要过程原文时按它 Read */
  noteFile?: string;
}

function clip(text: string | undefined, max = FIELD_MAX): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 月份分片：2026-08 → <ARCHIVE_ROOT>/2026-08.jsonl */
export function archiveFileOf(month: string): string {
  return join(ARCHIVE_ROOT, `${month}.jsonl`);
}

function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

/**
 * 落一条归档。
 *
 * 失败**不抛**：档案是辅助设施，不能让它反过来把任务终态搞挂（同 appendWorkbench）。
 *
 * 同一任务会被写多次（验收返工、retryFailed 复活、重启补交接都会重放终态钩子），
 * 这里**不去重**——查重要先读全文就又变回 read-modify-write 了。读侧按 taskId 取后写的那条。
 */
export function appendTaskArchive(record: TaskArchiveRecord): void {
  const entry: TaskArchiveRecord = {
    taskId: record.taskId,
    chatId: record.chatId,
    at: record.at,
    state: record.state,
    agentName: record.agentName,
    ...(record.agentKind ? { agentKind: record.agentKind } : {}),
    ...(record.channel ? { channel: record.channel } : {}),
    title: clip(record.title, TITLE_MAX) ?? "(无标题)",
    ...(clip(record.conclusion) ? { conclusion: clip(record.conclusion) } : {}),
    ...(clip(record.deliverables) ? { deliverables: clip(record.deliverables) } : {}),
    ...(clip(record.verification) ? { verification: clip(record.verification) } : {}),
    ...(clip(record.risks) ? { risks: clip(record.risks) } : {}),
    ...(clip(record.decisions) ? { decisions: clip(record.decisions) } : {}),
    ...(clip(record.error) ? { error: clip(record.error) } : {}),
    ...(clip(record.acceptance) ? { acceptance: clip(record.acceptance) } : {}),
    ...(record.reassigns ? { reassigns: record.reassigns } : {}),
    ...(record.noteFile ? { noteFile: record.noteFile } : {}),
  };
  try {
    mkdirSync(ARCHIVE_ROOT, { recursive: true });
    appendFileSync(archiveFileOf(monthOf(entry.at)), `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error) {
    console.error(`[archive] 任务 ${record.taskId} 落档失败:`, error);
  }
}

/** 全部月份分片，新到旧 */
function monthsDesc(): string[] {
  if (!existsSync(ARCHIVE_ROOT)) return [];
  try {
    return readdirSync(ARCHIVE_ROOT)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function readMonth(month: string): TaskArchiveRecord[] {
  let raw: string;
  try {
    raw = readFileSync(archiveFileOf(month), "utf-8");
  } catch {
    return [];
  }
  const out: TaskArchiveRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as TaskArchiveRecord;
      if (rec.taskId && rec.at) out.push(rec);
    } catch {
      // 坏行静默跳过：档案是辅助设施，一行坏了不该让整段历史消失
    }
  }
  return out;
}

export interface ArchiveQuery {
  /** 在标题 / 结论 / 决策 / 产出物里做不区分大小写的子串匹配 */
  keyword?: string;
  /** 限定员工（员工侧查询由调用方强制填自己，做不到越权） */
  agentName?: string;
  chatId?: string;
  /**
   * 排除某个会话。给员工做跨会话注入时用：当前会话那部分已由工作台索引覆盖，
   * 再注入一遍等于把同一批任务说两遍，还白占注入窗口。
   */
  excludeChatId?: string;
  state?: TaskArchiveRecord["state"];
  /** 起始日期（YYYY-MM-DD，含当天） */
  since?: string;
  limit?: number;
}

/** 一次查询最多回多少条：查询结果要进模型上下文，不能无界 */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function matches(rec: TaskArchiveRecord, q: ArchiveQuery, sinceMs?: number): boolean {
  if (q.agentName && rec.agentName !== q.agentName) return false;
  if (q.chatId && rec.chatId !== q.chatId) return false;
  if (q.excludeChatId && rec.chatId === q.excludeChatId) return false;
  if (q.state && rec.state !== q.state) return false;
  if (sinceMs != null && rec.at < sinceMs) return false;
  if (q.keyword) {
    const needle = q.keyword.toLowerCase();
    const hay = [rec.title, rec.conclusion, rec.decisions, rec.deliverables, rec.error]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/**
 * 查档案，新到旧返回。
 *
 * 按月分片从新往旧扫，凑够 limit 就停——常见问法（「最近有没有干过 X」）只会碰一两个文件。
 * 同一 taskId 只保留最新那条（终态钩子会重放，见 appendTaskArchive）。
 */
export function searchTaskArchive(query: ArchiveQuery): TaskArchiveRecord[] {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const sinceMs = query.since ? Date.parse(`${query.since}T00:00:00Z`) : undefined;
  const seen = new Set<string>();
  const out: TaskArchiveRecord[] = [];
  for (const month of monthsDesc()) {
    // since 落在更早的月份之后：这个月整个可以跳过（分片的意义就在这里）
    if (sinceMs != null && Date.parse(`${month}-01T00:00:00Z`) + 31 * 86400_000 < sinceMs) continue;
    const recs = readMonth(month).sort((a, b) => b.at - a.at);
    for (const rec of recs) {
      if (seen.has(rec.taskId)) continue;
      if (!matches(rec, query, sinceMs)) continue;
      seen.add(rec.taskId);
      out.push(rec);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 取单条档案全文（同 taskId 多条时取最新那条） */
export function getTaskArchiveRecord(taskId: string): TaskArchiveRecord | undefined {
  for (const month of monthsDesc()) {
    const hits = readMonth(month).filter((r) => r.taskId === taskId);
    if (hits.length > 0) return hits.sort((a, b) => b.at - a.at)[0];
  }
  return undefined;
}

/** 员工注入用的条数：开场只给一眼能扫完的量，更早的靠 search_task_history 查 */
export const ARCHIVE_INJECT_LIMIT = 5;

/**
 * 渲染「我在其它会话里最近做过什么」的注入摘要（新到旧）。
 * 排除当前会话——那部分由工作台索引负责，两处都注入等于重复。
 * 无记录返回 undefined，由调用方决定整段是否出现。
 */
export function renderRecentArchive(
  agentName: string,
  opts: { excludeChatId?: string; limit?: number } = {},
): string | undefined {
  const recs = searchTaskArchive({
    agentName,
    ...(opts.excludeChatId ? { excludeChatId: opts.excludeChatId } : {}),
    limit: opts.limit ?? ARCHIVE_INJECT_LIMIT,
  });
  if (recs.length === 0) return undefined;
  return recs.map(renderArchiveLine).join("\n");
}

/** 一条档案渲染成一行摘要（注入与查询结果共用同一版式，避免两处漂移） */
export function renderArchiveLine(rec: TaskArchiveRecord): string {
  const mark = rec.state === "done" ? "✅" : rec.state === "failed" ? "❌" : "⛔";
  const day = new Date(rec.at).toISOString().slice(0, 10);
  const gist = rec.conclusion ?? rec.error ?? "（无结论）";
  return `- ${mark} #${rec.taskId} ${day}｜${rec.title}\n  └ ${gist}`;
}
