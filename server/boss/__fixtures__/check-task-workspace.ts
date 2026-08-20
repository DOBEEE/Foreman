/**
 * per-task 工作目录清理的校验（零 LLM，纯断言）。
 *
 * 为什么必须专测：这是**删目录**的代码，两个方向都危险且都不会当场报错 ——
 * - 删多了：把还在跑的任务的工作树删掉（clone、分支、未提交改动一起没），
 *   而员工只会在下一次工具调用时看到「文件不见了」，然后开始瞎猜。
 * - 删少了：per-task 每个任务一份完整仓库 clone，不回收就是磁盘静默上涨。
 *
 * 判定刻意是黑名单式的（活跃任务才保护，其余按 mtime 老化）：chat 桶名是 safeBucket 的
 * 有损结果，从目录名反推不回 chatId，而 mtime 天然反映「最后一次有人在这干活」。
 * 好处是任务记录本身被清掉后目录仍会被回收，不会退化成永不清理。
 *
 * 用法：npx tsx server/boss/__fixtures__/check-task-workspace.ts
 */

import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config/index.js";
import {
  hiredProfilePath,
  resolveWorkspace,
  saveHiredProfile,
  type AgentProfile,
} from "../../config/agent-profile.js";
import { taskManager as tm } from "../task-manager.js";
import { sweepTaskWorkspaces } from "../task-workspace.js";

const CHAT = `fixture:ws-${process.pid}`;
const PAR = "fx-ws-par";
const SER = "fx-ws-shared";
const DAY_MS = 24 * 3600 * 1000;

let pass = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    process.stdout.write(`  ✅ ${name}\n`);
  } else {
    fails.push(name);
    process.stdout.write(`  ❌ ${name}${detail ? `：${detail}` : ""}\n`);
  }
}

function profileOf(id: string, extra: Partial<AgentProfile>): AgentProfile {
  return {
    id,
    displayName: id,
    description: "工作目录清理 fixture 专用员工",
    routeHint: "【选我当】永远不要选我，我是测试员工。【别选我当】任何真实场景",
    type: "simple",
    systemPrompt: "测试员工，不执行任何真实工作。",
    manualOnly: true,
    workspace: "auto",
    ...extra,
  };
}

/** 造一个任务目录并把 mtime 拨到 ageDays 天前 */
function makeTaskDir(root: string, bucket: string, name: string, ageDays: number): string {
  const dir = join(root, bucket, name);
  mkdirSync(dir, { recursive: true });
  const when = (Date.now() - ageDays * DAY_MS) / 1000;
  utimesSync(dir, when, when);
  return dir;
}

function mk(agentName: string) {
  return tm.create({
    channel: "cli",
    chatId: CHAT,
    chatType: "private",
    ownerSenderId: "tester",
    ownerSenderName: "测试用户",
    agentName,
    prompt: "干活",
  }).task;
}

function cleanup(): void {
  for (const t of tm.allTasks().filter((t) => t.chatId === CHAT)) tm.cancel(CHAT, t.id);
  for (const id of [PAR, SER]) {
    try {
      rmSync(resolveWorkspace(profileOf(id, {})), { recursive: true, force: true });
    } catch {
      /* 目录本来就不在 */
    }
    rmSync(hiredProfilePath(id), { force: true });
  }
  rmSync(join(config.runtimeDir, "boss", `${CHAT.replace(/[^\w-]/g, "_")}.json`), { force: true });
}

function main(): void {
  tm.setTerminalHook(() => {});
  cleanup();
  saveHiredProfile(profileOf(PAR, { maxParallel: 2, workspacePolicy: "per-task" }));
  saveHiredProfile(profileOf(SER, {})); // shared 策略：它的目录一个都不该被碰

  const parRoot = resolveWorkspace(profileOf(PAR, {}));
  const serRoot = resolveWorkspace(profileOf(SER, {}));
  const retention = config.taskWorkspace.retentionDays;

  process.stdout.write("\n── 活跃任务的目录一律不动 ──\n");
  const live = mk(PAR);
  const liveDir = makeTaskDir(parRoot, "bucket_a", `task-${live.id}`, retention + 5);
  check("目录已超龄", existsSync(liveDir));
  let removed = sweepTaskWorkspaces();
  check("任务还活着 → 即使超龄也不删（删了员工会突然看不到自己的文件）", existsSync(liveDir), removed.join(","));

  process.stdout.write("\n── 超龄且非活跃 → 回收 ──\n");
  const staleDir = makeTaskDir(parRoot, "bucket_a", "task-deadbee", retention + 1);
  const freshDir = makeTaskDir(parRoot, "bucket_a", "task-freshaa", 0);
  removed = sweepTaskWorkspaces();
  check("超龄的被删", !existsSync(staleDir), staleDir);
  check("还在保留期内的不删（用户可能刚要回去看 diff）", existsSync(freshDir));
  check("活跃任务的目录仍在", existsSync(liveDir));
  check("返回值列出被删的那个", removed.length === 1 && removed[0] === staleDir, removed.join(","));

  process.stdout.write("\n── 任务终态后按保留期老化（不是终态即删） ──\n");
  tm.markDone(CHAT, live.id, "交付完成");
  check("终态后目录还在（验收员还要读、用户还要看 diff）", existsSync(liveDir));
  removed = sweepTaskWorkspaces();
  check("终态且超龄 → 这一轮回收掉", !existsSync(liveDir), removed.join(","));

  process.stdout.write("\n── 只碰自己造的 task-* 目录 ──\n");
  const chatClone = join(parRoot, "bucket_a");
  const strayFile = makeTaskDir(parRoot, "bucket_a", "repo-legacy", retention + 9);
  sweepTaskWorkspaces();
  check("chat 桶本身不删（per-chat 时代的 clone 可能有未提交的工作）", existsSync(chatClone));
  check("非 task- 前缀的目录不碰（不是我造的就不该我删）", existsSync(strayFile), strayFile);

  process.stdout.write("\n── 非 per-task 岗位完全不参与 ──\n");
  const serDir = makeTaskDir(serRoot, "bucket_a", "task-oldold", retention + 9);
  sweepTaskWorkspaces();
  check("shared 岗位目录下的 task-* 也不动（它压根不该有这种目录）", existsSync(serDir), serDir);

  process.stdout.write("\n── runtimeDir 之外拒绝删 ──\n");
  const outside = join(config.serviceRoot, `.fx-outside-${process.pid}`);
  const outsideTask = makeTaskDir(outside, "bucket_a", "task-oldold", retention + 9);
  saveHiredProfile(profileOf(PAR, { maxParallel: 2, workspacePolicy: "per-task", workspace: outside }));
  removed = sweepTaskWorkspaces();
  check(
    "workspace 指到 runtimeDir 之外时一个都不删（配置写歪不该让清理器去删别人的代码）",
    existsSync(outsideTask) && !removed.includes(outsideTask),
    removed.join(","),
  );
  rmSync(outside, { recursive: true, force: true });

  process.stdout.write(`\n━━━ ${pass}/${pass + fails.length} 通过 ━━━\n`);
  if (fails.length) {
    process.stdout.write(`未通过：${fails.join("、")}\n`);
    process.exitCode = 1;
  }
}

try {
  main();
} finally {
  cleanup();
}
