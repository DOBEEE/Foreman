import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import type { TaskRecord } from "./types.js";

const tasksDir = join(config.runtimeDir, "tasks");

export function saveTaskRecord(record: TaskRecord): void {
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, `${record.taskId}.json`),
    JSON.stringify(record, null, 2),
  );
}

export function loadTaskRecord(taskId: string): TaskRecord | undefined {
  // taskId 来自请求参数，先过滤路径字符防目录穿越
  if (!/^[\w-]+$/.test(taskId)) return undefined;
  try {
    return JSON.parse(
      readFileSync(join(tasksDir, `${taskId}.json`), "utf-8"),
    ) as TaskRecord;
  } catch {
    return undefined;
  }
}
