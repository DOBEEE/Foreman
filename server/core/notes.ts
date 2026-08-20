import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config/index.js";

/**
 * 员工随手笔记（原料层，与经验库严格分工）：
 * - 员工在踩坑当场 / 换方向前 / 交卷前**自己**追加，只写自己的目录
 * - 复盘员每日读「笔记 + 执行日志」蒸馏进经验库；笔记提供线索，trace 提供事实
 * - 笔记是**可丢弃原料**：按日分文件、超过 TTL 自动清理；值得留下的必须被蒸馏进 memory
 *
 * 与 memory/ 的区别：memory 是资产（只有复盘员能写、长期保留、会注入系统提示词），
 * notes 是原料（员工自己写、到期即删、不自动注入，只在需要时按路径 Read）。
 */
export const NOTES_ROOT = join(config.runtimeDir, "notes");

/** 笔记保留天数：到期自动清理（值得沉淀的应已被复盘蒸馏进经验库） */
export const NOTES_TTL_DAYS = 14;

/** 复盘回看的天数：覆盖「昨天复盘没跑成」的情况，重复条目由复盘的去重合并兜住 */
export const NOTES_LOOKBACK_DAYS = 3;

export function notesDirOf(agentName: string): string {
  return join(NOTES_ROOT, agentName);
}

/**
 * 某员工某天的笔记文件。
 *
 * `taskId` 只在**并发岗位**上传（`maxParallel > 1`）：那种岗位同一天会有两个 run 同时
 * 在写笔记，而写法是「Read 现有内容 → Write 追加后的全文」——两个 run 交错时后写的那个
 * 会**整体覆盖**前一个，静默丢掉一整份笔记。笔记是复盘信号密度最高的输入，丢了就是复盘失真。
 *
 * 串行岗位不传，文件名保持 `<date>.md` 一字不变（零迁移）。
 */
export function noteFileOf(agentName: string, date: string, taskId?: string): string {
  const suffix = taskId ? `${date}.${safeSegment(taskId)}` : date;
  return join(notesDirOf(agentName), `${suffix}.md`);
}

/** 任务号进文件名前先消毒：任务号本身是 uuid 片段，但不能假设调用方永远只传它 */
function safeSegment(raw: string): string {
  return raw.replace(/[^\w-]/g, "_").slice(0, 40) || "task";
}

/** 带边界的目录归属判定：裸 startsWith 会让 notes/lead 错误匹配 notes/leadership */
function withinDir(target: string, dir: string): boolean {
  const base = resolve(dir);
  const t = resolve(target);
  return t === base || t.startsWith(`${base}/`);
}

/** 写入范围判定：路径是否落在某员工自己的笔记目录内 */
export function isOwnNotesPath(p: string, agentName: string): boolean {
  return withinDir(p, notesDirOf(agentName));
}

export function isNotesPath(p: string): boolean {
  return withinDir(p, NOTES_ROOT);
}

/** 目录先建好，省得员工第一次写笔记时因目录不存在而多花一轮 */
export function ensureNotesDir(agentName: string): string {
  const dir = notesDirOf(agentName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 复盘要读的笔记文件清单（当天 + 往前 lookback 天，只返回存在的）。
 *
 * 按**日期前缀扫目录**而不是拼精确文件名：并发岗位同一天会有多份 `<date>.<taskId>.md`，
 * 拼文件名只能命中 `<date>.md`，那些并行任务的笔记会被复盘整体漏掉——
 * 而漏掉的恰恰是「员工主动认定值得留下」的判断与教训。
 */
export function noteFilesForRetro(
  agentName: string,
  date: string,
  lookbackDays = NOTES_LOOKBACK_DAYS,
): string[] {
  const dir = notesDirOf(agentName);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (let i = 0; i < lookbackDays; i++) {
    const day = shiftDate(date, -i);
    // 同一天内多份按文件名排序，保证复盘输入顺序稳定（否则目录顺序随文件系统漂）
    const sameDay = entries
      .filter((name) => name === `${day}.md` || name.startsWith(`${day}.`))
      .filter((name) => name.endsWith(".md"))
      .sort();
    for (const name of sameDay) files.push(join(dir, name));
  }
  return files;
}

/** 当天笔记正文（供员工续跑时自读；缺失返回 undefined） */
export function readTodayNote(
  agentName: string,
  date: string,
  taskId?: string,
): string | undefined {
  const file = noteFileOf(agentName, date, taskId);
  try {
    const text = readFileSync(file, "utf-8").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 清理过期笔记（按文件名日期判断，文件名不合规的按 mtime 兜底）。
 * 返回删除的文件数，启动时与每次复盘后各跑一次。
 */
export function cleanupNotes(ttlDays = NOTES_TTL_DAYS): number {
  if (!existsSync(NOTES_ROOT)) return 0;
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const agent of readdirSync(NOTES_ROOT)) {
    const dir = join(NOTES_ROOT, agent);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const file = join(dir, name);
      try {
        // 允许任务号中缀（并发岗位的 <date>.<taskId>.md）。不放宽的话这些文件会全部
        // 落到 mtime 兜底分支——仍能删，但保留期变成「最后写入起算」，与同日其它笔记不齐
        const dateMatch = /^(\d{4}-\d{2}-\d{2})(?:\.[\w-]+)?\.md$/.exec(name);
        const stamp = dateMatch
          ? Date.parse(`${dateMatch[1]}T23:59:59Z`)
          : statSync(file).mtimeMs;
        if (stamp < cutoff) {
          rmSync(file);
          removed++;
        }
      } catch {
        // 单个文件清理失败不影响其余
      }
    }
  }
  return removed;
}
