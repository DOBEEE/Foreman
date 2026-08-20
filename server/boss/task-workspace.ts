import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import {
  listHiredProfiles,
  loadAgentProfile,
  resolveWorkspace,
  type AgentProfile,
} from "../config/agent-profile.js";
import { getBuiltinAgentIds } from "../agents/registry.js";
import { taskManager as tm } from "./task-manager.js";

/**
 * per-task 工作目录的到期清理。
 *
 * 为什么需要：`workspacePolicy: "per-task"` 给每个任务一份独立工作目录（对 coder 就是
 * 一份完整仓库 clone）。这份隔离是并发的前提——两个任务各一棵工作树才不会互相踩踏，
 * 也不会出现「看到对方的脏改动就停下来问用户」。代价就是磁盘会累积，必须有人回收。
 *
 * 与临时工清理（temp-worker.ts）刻意保持同一形状：都挂在 scheduler.scan 里（那里持有
 * 调度单实例锁，不会有两个进程抢着删同一批文件），都用「有活跃任务一律跳过」当第一道闸。
 */

/** 任务专属目录的固定前缀，与 base-agent.resolveRunCwd 的分桶写法一一对应 */
const TASK_DIR_PREFIX = "task-";

function retentionMs(): number {
  return config.taskWorkspace.retentionDays * 24 * 3600 * 1000;
}

/** 声明了 per-task 的全部岗位（内置 + 招聘） */
function perTaskProfiles(): AgentProfile[] {
  const out: AgentProfile[] = [];
  const seen = new Set<string>();
  const consider = (profile: AgentProfile | undefined): void => {
    if (!profile || seen.has(profile.id)) return;
    seen.add(profile.id);
    if (profile.workspacePolicy === "per-task") out.push(profile);
  };
  for (const id of getBuiltinAgentIds()) consider(loadAgentProfile(id));
  for (const profile of listHiredProfiles({ includeTemp: true })) consider(profile);
  return out;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 删一个任务目录。只允许删 runtimeDir 底下的——配置把 workspace 写歪（比如指到用户的
 * 真实仓库）时，这一道保险的价值是「清理器不会去删别人的代码」。抄 temp-worker.rmDir。
 */
function rmTaskDir(dir: string): boolean {
  if (!dir.startsWith(config.runtimeDir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    // 清不掉不影响主流程，下一轮再试
    return false;
  }
}

/**
 * 扫一遍并清理到期的 per-task 工作目录，返回被删掉的目录路径。
 *
 * 判定刻意是**黑名单式**的：「taskId 出现在活跃任务里」才保护，其余按目录 mtime 老化。
 * 不去反查任务状态，因为 chat 桶名是 `safeBucket()` 的有损结果（非 `\w-` 字符全被替成
 * `_`），从目录名反推不回 chatId；而 mtime 天然反映「最后一次有人在这里干活」。
 * 这样即使任务记录本身被清掉了（chat 存档删除、跨版本迁移），目录也仍会被回收，
 * 不会退化成永不清理。
 */
export function sweepTaskWorkspaces(now = Date.now()): string[] {
  const cutoff = now - retentionMs();
  // 一次性取全量活跃任务：逐目录去查会把 N 个 chat 的存档读 N 遍
  const activeTaskIds = new Set(tm.allActiveTasks().map((t) => t.id));
  const removed: string[] = [];

  for (const profile of perTaskProfiles()) {
    const root = resolveWorkspace(profile);
    if (!existsSync(root)) continue;
    let chatBuckets: string[];
    try {
      chatBuckets = readdirSync(root);
    } catch {
      continue;
    }
    for (const bucket of chatBuckets) {
      const bucketDir = join(root, bucket);
      if (!isDir(bucketDir)) continue;
      let entries: string[];
      try {
        entries = readdirSync(bucketDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        // 只碰自己造的 task-* 目录。chat 桶本身不删（per-chat 时代留下的 clone 可能
        // 还有用户未提交的工作，那是不可逆动作，不该由定时清理替用户决定）
        if (!name.startsWith(TASK_DIR_PREFIX)) continue;
        const dir = join(bucketDir, name);
        if (!isDir(dir)) continue;
        if (activeTaskIds.has(name.slice(TASK_DIR_PREFIX.length))) continue;
        let mtime: number;
        try {
          mtime = statSync(dir).mtimeMs;
        } catch {
          continue;
        }
        if (mtime >= cutoff) continue;
        if (rmTaskDir(dir)) removed.push(dir);
      }
    }
  }

  if (removed.length > 0) {
    console.log(
      `[workspace] 清理到期任务目录 ${removed.length} 个（保留期 ${config.taskWorkspace.retentionDays} 天）`,
    );
  }
  return removed;
}
