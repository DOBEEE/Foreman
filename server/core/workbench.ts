import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config/index.js";

/**
 * 员工工作台（`agent × chat` 维度的持久工作记忆）。
 *
 * 补的是这个缺口：上下文（session）是**按任务**隔离的，所以员工在同一个群里干第二件活时
 * 是一个全新会话，对自己做过什么一无所知。而"做过什么"这类知识本来就不该建在消息历史上——
 * 消息历史是线性单写者（两个并发 run 没法往一个数组里 append）、无界增长、靠有损压缩收口、
 * 且不可检索。工作台把它换成可检索的结构化记录。
 *
 * 三层分工（别混）：
 * - `notes/`   原料：员工自己在过程中趁热写，14 天即删，写给复盘员看
 * - `workbench/` 工作记忆：**系统**在任务收尾时自动落，按 chat 分组，开场注入索引给员工看
 * - `memory/`  资产：复盘员从上面两者蒸馏，跨 chat 长期保留
 *
 * 工作台的数据不用额外向模型索取：`report_task_done` 的结构化入参就是全部素材。
 */
export const WORKBENCH_ROOT = join(config.runtimeDir, "workbench");

/** 保留天数。比 notes（14 天）长：它是"这个群里做过什么"的索引，比原料更该留住 */
export const WORKBENCH_TTL_DAYS = 60;

/** 默认注入几条。索引是给模型开场扫一眼的，不是完整档案——要细节让它按路径 Read */
export const WORKBENCH_INDEX_LIMIT = 12;

export interface WorkbenchRecord {
  taskId: string;
  /** 落库时刻 */
  at: number;
  state: "done" | "failed" | "cancelled";
  /** 任务在说什么（取 prompt 首行，仅用于让员工认出是哪件活） */
  title: string;
  /** report_task_done 的结构化字段（cannot_complete / 失败时可能缺） */
  conclusion?: string;
  deliverables?: string;
  verification?: string;
  risks?: string;
  /** 关键决策与理由：消息历史里推不出来的那部分，工作台最有价值的一列 */
  decisions?: string;
  /** 失败原因（没交卷就失败时只有这个） */
  error?: string;
  /** 当时的随手笔记路径，供需要原文时按路径 Read */
  noteFile?: string;
}

export function workbenchDirOf(agentName: string): string {
  return join(WORKBENCH_ROOT, agentName);
}

/**
 * chatId → 文件名。与 `boss/store.ts` 的 `safeKey` 同一套替换规则。
 *
 * 这个映射是**有损**的（所有非 `\w-` 字符都变 `_`），所以只能正向用；
 * 想从文件名反推 chatId 是不成立的，别写那种代码。
 */
function safeKey(chatId: string): string {
  return chatId.replace(/[^\w-]/g, "_");
}

export function workbenchFileOf(agentName: string, chatId: string): string {
  return join(workbenchDirOf(agentName), `${safeKey(chatId)}.jsonl`);
}

/** 带边界的目录归属判定：裸 startsWith 会让 workbench/lead 错误匹配 workbench/leadership */
function withinDir(target: string, dir: string): boolean {
  const base = resolve(dir);
  const t = resolve(target);
  return t === base || t.startsWith(`${base}/`);
}

export function isWorkbenchPath(p: string): boolean {
  return withinDir(p, WORKBENCH_ROOT);
}

/**
 * 追加一条记录。
 *
 * **必须是 append 而不是"读全文 → 改 → 写回"**：并发岗位（maxParallel > 1）同一时刻会有
 * 两个 run 收尾，read-modify-write 交错时后写的那个会整体覆盖前一个。`notes` 当初就是因为
 * 用了 Read→Write 全文覆盖，才不得不按 taskId 拆成多个文件来回避竞争——那是治症状。
 * append 是治根因：O_APPEND 下每次写入的定位与写出是原子的，不需要拆文件也不会互相覆盖。
 *
 * 落库失败**不抛**：工作台是辅助记忆，不能让它反过来把任务终态搞挂
 * （同 `task-manager.setState` 对终态钩子的处理）。
 */
export function appendWorkbench(
  agentName: string,
  chatId: string,
  record: WorkbenchRecord,
): void {
  try {
    mkdirSync(workbenchDirOf(agentName), { recursive: true });
    appendFileSync(workbenchFileOf(agentName, chatId), `${JSON.stringify(record)}\n`, "utf-8");
  } catch (error) {
    console.error(`[workbench] ${agentName}/${chatId} 落库失败:`, error);
  }
}

/**
 * 读回记录，**按 taskId 去重、后写的赢**，按时间升序返回。
 *
 * 去重是必需的而不是保险：同一个任务的终态事件**会来多次**——验收返工让任务多次进出
 * running、`retryFailed` 会复活失败任务、重启补交接（`recoverPendingHandoffs`）还会主动
 * 重放一遍终态钩子。选择"允许重复写入 + 读时后写的赢"而不是"写前查重"，是为了守住
 * append-only：查重要先读全文，那就又变回 read-modify-write 了。
 *
 * 坏行（人手改坏、写入被截断）静默跳过：工作台是辅助记忆，一行坏了不该让整个索引消失。
 */
export function loadWorkbench(agentName: string, chatId: string): WorkbenchRecord[] {
  const file = workbenchFileOf(agentName, chatId);
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const byTask = new Map<string, WorkbenchRecord>();
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const rec = JSON.parse(text) as WorkbenchRecord;
      if (!rec?.taskId) continue;
      byTask.set(rec.taskId, rec);
    } catch {
      // 坏行跳过
    }
  }
  return [...byTask.values()].sort((a, b) => a.at - b.at);
}

const STATE_MARK: Record<WorkbenchRecord["state"], string> = {
  done: "✅",
  failed: "❌",
  cancelled: "⛔",
};

/** 单行压缩：换行/多空白都塌成一个空格，再按上限截断 */
function oneLine(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 渲染注入用的索引（无记录返回 undefined，调用方据此决定整段是否出现）。
 *
 * 刻意只给摘要 + 定位信息，不给全文：这段要进每个任务的系统提示，全量注入会随着历史
 * 线性膨胀，最终把上下文吃光——而那正是"共享一条长会话"方案的死法，不能在这里重演。
 * 需要细节时员工按 `noteFile` 路径 Read，或按任务号找主管要。
 */
export function renderWorkbenchIndex(
  agentName: string,
  chatId: string,
  limit = WORKBENCH_INDEX_LIMIT,
): string | undefined {
  const all = loadWorkbench(agentName, chatId);
  if (all.length === 0) return undefined;
  // 取最近 limit 条：越近的越可能与当前任务相关
  const recent = all.slice(-limit);
  const lines = recent.map((r) => {
    const head = `- #${r.taskId} ${STATE_MARK[r.state] ?? "·"} ${oneLine(r.title, 60) ?? "（无标题）"}`;
    const parts: string[] = [];
    const conclusion = oneLine(r.conclusion ?? r.error, 160);
    if (conclusion) parts.push(`结论：${conclusion}`);
    const decisions = oneLine(r.decisions, 200);
    if (decisions) parts.push(`关键决策：${decisions}`);
    const deliverables = oneLine(r.deliverables, 120);
    if (deliverables) parts.push(`产出：${deliverables}`);
    const risks = oneLine(r.risks, 120);
    if (risks && !/^无[。.]?$/.test(risks)) parts.push(`遗留：${risks}`);
    if (r.noteFile) parts.push(`笔记：${r.noteFile}`);
    return parts.length > 0 ? `${head}\n  ${parts.join("｜")}` : head;
  });
  const omitted = all.length - recent.length;
  return [
    ...(omitted > 0 ? [`（更早的 ${omitted} 条已省略，需要时向主管报任务号索取）`] : []),
    ...lines,
  ].join("\n");
}

/**
 * 删掉指定 chat 在**所有员工**名下的工作台文件，返回删除的文件数。
 *
 * **给 fixture 收尾用**，与 `boss/store.ts` 的 `dropChatTasks` 配对：任务进终态时会经
 * 终态钩子连带落一条工作台记录，所以只清任务库的话工作台会留下残留
 * （实测 `check-schedule-accounting` 跑完在真实目录留下一份 assistant 的 jsonl）。
 *
 * 要遍历员工目录是因为工作台按 `agent/chat` 两级存放，而 fixture 只知道自己用的 chatId，
 * 未必知道任务最终派给了谁（改派、临时工都会换人）。
 *
 * **只删这一个 chat 对应的那个文件**，绝不按文件名前缀批量删——并行跑多个 fixture 时
 * 会把对方的记录一起清掉。
 */
export function dropChatWorkbench(chatId: string): number {
  if (!existsSync(WORKBENCH_ROOT)) return 0;
  const target = `${safeKey(chatId)}.jsonl`;
  let removed = 0;
  for (const agent of readdirSync(WORKBENCH_ROOT)) {
    const dir = join(WORKBENCH_ROOT, agent);
    const file = join(dir, target);
    try {
      if (!existsSync(file)) continue;
      rmSync(file, { force: true });
      removed++;
      // 目录空了就一并收掉：否则每跑一次 fixture 就在真实目录留一个空的员工目录，
      // 正是「不痛但会一直堆积」的那类残留。
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch {
      // 单个删除失败不影响其余
    }
  }
  return removed;
}

/**
 * 清理过期记录。**按行清而不是按文件删**：一个 chat 的文件里既有半年前的也有今天的，
 * 整文件删会把还在用的一起带走。
 *
 * 这是全代码库唯一会重写工作台文件的地方，且只在启动/定时清理时跑（与任务收尾不并发）。
 * 返回删掉的行数。
 */
export function cleanupWorkbench(ttlDays = WORKBENCH_TTL_DAYS): number {
  if (!existsSync(WORKBENCH_ROOT)) return 0;
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const agent of readdirSync(WORKBENCH_ROOT)) {
    const dir = join(WORKBENCH_ROOT, agent);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      try {
        const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
        const kept = lines.filter((line) => {
          try {
            const rec = JSON.parse(line) as WorkbenchRecord;
            // 时间戳缺失/坏行一律保留：宁可留着占几字节，也不要静默删掉可能有用的记录
            return typeof rec.at !== "number" || rec.at >= cutoff;
          } catch {
            return true;
          }
        });
        if (kept.length === lines.length) continue;
        removed += lines.length - kept.length;
        if (kept.length === 0) rmSync(file);
        else writeAtomic(file, `${kept.join("\n")}\n`);
      } catch {
        // 单文件清理失败不影响其余
      }
    }
  }
  return removed;
}

/** 同目录临时文件 + rename：清理过程中进程退出时，旧文件仍保持完整 */
function writeAtomic(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, "utf-8");
    // rename 在同一文件系统内是原子的，读方不会看到半截文件
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
