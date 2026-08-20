import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import type { Task } from "./types.js";

/**
 * Boss 任务持久化：每个 chat 一个 json 文件，重启恢复未完成任务。
 * 按 chatId 分文件，天然多租户隔离。
 */
const bossDir = join(config.runtimeDir, "boss");

function safeKey(chatId: string): string {
  return chatId.replace(/[^\w-]/g, "_");
}

function fileOf(chatId: string): string {
  return join(bossDir, `${safeKey(chatId)}.json`);
}

/**
 * 删掉某个 chat 的整个任务库文件。
 *
 * **给 fixture 收尾用**：fixture 往真实 runtimeDir 写任务，跑完不清就会在看板上堆出
 * 幽灵任务——实测一轮全量回归堆了 1014 条，还让 coder 常年挂着「7 待确认 + 10 排队」。
 * 导出这个函数而不是让每个 fixture 自己拼路径，是为了让路径推导只有 `fileOf` 一处：
 * 拼歪了不会报错，只会删不掉（或者更糟，删到别的 chat）。
 *
 * 生产代码不该调它：真实会话的任务库是审计与恢复的依据。
 */
export function dropChatTasks(chatId: string): void {
  rmSync(fileOf(chatId), { force: true });
}

/**
 * 标记存在之前就落盘的定时任务补 scheduled=true。
 *
 * 为什么需要：Task.scheduled 是后加的字段，此前每天跑的复盘任务已经把不少 chat 的
 * 「最近收尾」占满了；不回填它们就会继续把用户自己的任务挤出 boss 视野。
 * 只认这两个**内置**定时岗（见 scheduler 的 seedBuiltins），刻意不引 agent registry
 * 判 manualOnly——那会形成 store → registry → … 的 import 环；用户自建的 schedule
 * 从现在起由 dispatchScheduledTask 正常写入标记，无需猜。
 */
const LEGACY_SCHEDULED_AGENTS = new Set(["retro", "optimizer"]);

function backfillScheduled(tasks: Task[]): Task[] {
  for (const t of tasks) {
    if (t.scheduled === undefined && LEGACY_SCHEDULED_AGENTS.has(t.agentName)) {
      t.scheduled = true;
    }
  }
  return tasks;
}

/** 读取某 chat 的全部任务（时间升序） */
export function loadChatTasks(chatId: string): Task[] {
  try {
    const parsed = JSON.parse(readFileSync(fileOf(chatId), "utf-8"));
    return Array.isArray(parsed) ? backfillScheduled(parsed as Task[]) : [];
  } catch {
    return [];
  }
}

/** 覆盖写入某 chat 的任务列表 */
export function saveChatTasks(chatId: string, tasks: Task[]): void {
  try {
    mkdirSync(bossDir, { recursive: true });
    writeFileSync(fileOf(chatId), JSON.stringify(tasks, null, 2));
  } catch {
    // 持久化失败不阻塞主流程
  }
}

/**
 * 扫描所有已知 chat 的原始 chatId（从任务文件里读取，避免 safeKey 失真）。
 * Dashboard 汇总跨 chat 视图时用。
 */
export function listAllChatIds(): string[] {
  let files: string[] = [];
  try {
    files = readdirSync(bossDir).filter(
      (f) => f.endsWith(".json") && f !== "boss-sessions.json",
    );
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const file of files) {
    const tasks = loadChatTasks(file.replace(/\.json$/, ""));
    const real = tasks[0]?.chatId;
    if (real) out.add(real);
  }
  return [...out];
}

/**
 * 启动恢复：扫描所有 chat 文件，把中断时处于 running 的任务重置为 queued
 * （进程重启后 in-flight 执行已丢失，需重新派发）。waiting_user 保持不变（等用户回答）。
 * 返回 chatId → 需重新派发的任务列表。
 */
/** 同一任务因中断重新派发的次数上限：超过即判失败，不再无限重跑 */
const MAX_RECOVERS = 3;

export function recoverInterruptedTasks(): {
  requeued: Map<string, Task[]>;
  aborted: Task[];
} {
  const result = new Map<string, Task[]>();
  const abortedAll: Task[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(bossDir).filter(
      // 只扫任务文件：排除同目录下的 boss-sessions.json（对象）等非任务 json
      (f) => f.endsWith(".json") && f !== "boss-sessions.json",
    );
  } catch {
    return { requeued: result, aborted: abortedAll };
  }
  for (const file of files) {
    const chatId = file.replace(/\.json$/, "");
    const tasks = loadChatTasks(chatId);
    let changed = false;
    const requeued: Task[] = [];
    const aborted: Task[] = [];
    for (const t of tasks) {
      if (t.state !== "running") continue;
      const recovered = (t.recoverCount ?? 0) + 1;
      t.recoverCount = recovered;
      t.updatedAt = Date.now();
      changed = true;
      if (recovered > MAX_RECOVERS) {
        // 反复中断且永远跑不完：判失败并交由上层告知用户，别再无限重跑
        t.state = "failed";
        t.error = `任务被中断并重新派发 ${recovered - 1} 次仍未完成，已停止重试（可能每次都在同一处崩溃，或服务在频繁重启）`;
        t.question = undefined;
        aborted.push(t);
        continue;
      }
      t.state = "queued";
      requeued.push(t);
    }
    if (changed) {
      saveChatTasks(chatId, tasks);
      // 用真实 chatId（文件名 safeKey 后可能失真，用任务里的原值）
      const realChatId = tasks[0]?.chatId ?? chatId;
      if (requeued.length > 0) result.set(realChatId, requeued);
      abortedAll.push(...aborted);
    }
  }
  return { requeued: result, aborted: abortedAll };
}
