/**
 * 把历史任务回填进长期档案（一次性补账，可重复跑）。
 *
 * 为什么需要：归档是后加的设施，写入挂在任务终态钩子上，只对**此后**收尾的任务生效。
 * 而 `boss/<chatId>.json` 里躺着此前全部已收尾的任务——不回填，档案的前半段就是空的，
 * 员工与主管去查「三个月前那件活」照样查不到。
 *
 * 幂等：已在档案里的 taskId 直接跳过（按 taskId 判，不看内容）。所以重复执行安全，
 * 也可以在每次新增字段后再跑一遍补齐（旧记录不会被改写，只会新增缺失的那些）。
 *
 * 排除项与运行时收口保持一致：只收终态任务，且跳过 scheduled（定时任务的历史价值
 * 远低于它的体量，见 boss.ts recordTaskHistory 的注释）。
 *
 * 用法：npx tsx server/core/__fixtures__/backfill-task-archive.ts [--dry]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config/index.js";
import {
  appendTaskArchive,
  getTaskArchiveRecord,
  type TaskArchiveRecord,
} from "../task-archive.js";
import type { Task } from "../../boss/types.js";

const dry = process.argv.includes("--dry");
const bossDir = join(config.runtimeDir, "boss");

function chatStoreFiles(): string[] {
  if (!existsSync(bossDir)) return [];
  return readdirSync(bossDir)
    .filter((f) => f.endsWith(".json"))
    // boss 自己的运行时文件不是任务库
    .filter((f) => f !== "boss-sessions.json" && f !== "inflight-turns.json")
    .map((f) => join(bossDir, f));
}

function loadTasks(file: string): Task[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? (parsed as Task[]) : [];
  } catch {
    console.warn(`[backfill] 跳过读不动的任务库：${file}`);
    return [];
  }
}

function toRecord(task: Task): TaskArchiveRecord | undefined {
  if (task.state !== "done" && task.state !== "failed" && task.state !== "cancelled") return undefined;
  const report = task.report;
  return {
    taskId: task.id,
    chatId: task.chatId,
    // 没有终态时刻这个字段，用 updatedAt 当落档时间（它就是最后一次状态变更）
    at: task.updatedAt ?? task.createdAt ?? Date.now(),
    state: task.state,
    agentName: task.agentName,
    ...(task.channel ? { channel: task.channel } : {}),
    title: (task.brief ?? task.prompt).split("\n")[0] ?? "",
    ...(report?.conclusion ? { conclusion: report.conclusion } : {}),
    ...(report?.deliverables ? { deliverables: report.deliverables } : {}),
    ...(report?.verification ? { verification: report.verification } : {}),
    ...(report?.risks ? { risks: report.risks } : {}),
    ...(report?.decisions ? { decisions: report.decisions } : {}),
    // 没交卷的：result 是最终文本、error 是失败原因，两者都比空档案有价值
    ...(!report && task.result ? { conclusion: task.result } : {}),
    ...(!report && task.error ? { error: task.error } : {}),
    ...(task.acceptance ? { acceptance: task.acceptance } : {}),
    ...(task.reassigns ? { reassigns: task.reassigns } : {}),
  };
}

function main(): void {
  const files = chatStoreFiles();
  let scanned = 0;
  let written = 0;
  let skippedExisting = 0;
  let skippedScheduled = 0;
  let skippedActive = 0;

  for (const file of files) {
    for (const task of loadTasks(file)) {
      scanned++;
      if (task.scheduled) {
        skippedScheduled++;
        continue;
      }
      const record = toRecord(task);
      if (!record) {
        skippedActive++;
        continue;
      }
      if (getTaskArchiveRecord(record.taskId)) {
        skippedExisting++;
        continue;
      }
      if (!dry) appendTaskArchive(record);
      written++;
    }
  }

  console.log(
    [
      `${dry ? "[dry-run] " : ""}回填完成：扫了 ${files.length} 个任务库、${scanned} 条任务`,
      `  落档 ${written} 条`,
      `  跳过：已在档案 ${skippedExisting}｜定时任务 ${skippedScheduled}｜未收尾 ${skippedActive}`,
    ].join("\n"),
  );
}

main();
