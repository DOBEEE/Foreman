/**
 * 定时任务的记账与单实例约束的结构性校验（零 LLM，纯断言）。
 *
 * 为什么必须专测：这两件事**失效时完全无声**，只能靠事后翻 schedules.json 才发现。
 * 实测故障：归因只认进程内存里的 taskId→scheduleId 映射，serve 一重启这张表就空了，于是
 * 1. 在途任务的终态无人认领 → failCount 永不增长 → 阶梯退避与「连续失败自动停用」
 *    整条安全网静默失效。每日复盘 08-06 / 08-07 连着两天 failed，failCount 仍是 0。
 * 2. 单实例约束把「上一实例还在跑」判成 false → 同一 schedule 被叠上第二个实例。
 *
 * 用法：npx tsx server/scheduler/__fixtures__/check-schedule-accounting.ts
 */

import { taskManager as tm } from "../../boss/task-manager.js";
import {
  createSchedule,
  cycleKeyOf,
  getSchedule,
  LIMITS,
  removeSchedule,
  updateSchedule,
} from "../schedule-store.js";
import { accountTerminalTask, dependencyGate, stillRunning } from "../scheduler.js";
import { dropChatTasks } from "../../boss/store.js";
import { dropChatWorkbench } from "../../core/workbench.js";

const CHAT = "fixture:schedule-accounting";
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

function makeSchedule(
  title: string,
  timing: Parameters<typeof createSchedule>[0]["timing"] = { kind: "daily", hour: 21, minute: 0 },
  dependsOn?: string,
) {
  const result = createSchedule({
    title,
    agentName: "assistant",
    prompt: "跑一次",
    timing,
    channel: "cli",
    chatId: CHAT,
    chatType: "private",
    ownerSenderId: "tester",
    ownerSenderName: "测试用户",
    createdBy: "boss",
    ...(dependsOn ? { dependsOn } : {}),
  });
  if (!("schedule" in result)) throw new Error(`建 schedule 失败：${result.error}`);
  return result.schedule;
}

function makeTask() {
  return tm.create({
    channel: "cli",
    chatId: CHAT,
    chatType: "private",
    ownerSenderId: "tester",
    ownerSenderName: "测试用户",
    agentName: "assistant",
    prompt: "跑一次",
  }).task;
}

/** 模拟「派发完成」：只写持久字段，**不碰**内存映射——等价于派发后进程重启过 */
function dispatchedThenRestarted(scheduleId: string, taskId: string): void {
  updateSchedule(scheduleId, { lastTaskId: taskId, runCount: 1 });
}

function cleanup(ids: string[]): void {
  for (const id of ids) removeSchedule(id);
  for (const t of tm.allTasks().filter((t) => t.chatId === CHAT)) tm.cancel(CHAT, t.id);
}

function main(): void {
  const created: string[] = [];

  process.stdout.write("\n── 重启后仍能认领在途任务（failCount 曾永远是 0）──\n");
  const s1 = makeSchedule("记账-失败");
  created.push(s1.id);
  const t1 = makeTask();
  dispatchedThenRestarted(s1.id, t1.id);
  accountTerminalTask(t1.id, "failed", { error: "模型超时" });
  const after1 = getSchedule(s1.id)!;
  check("失败被记账（不依赖内存映射）", after1.failCount === 1, String(after1.failCount));
  check("落了退避时间", Boolean(after1.backoffUntil));
  check("记下已记账的任务 id", after1.lastAccountedTaskId === t1.id);

  process.stdout.write("\n── 同一轮只记一次账 ──\n");
  // 返工后再次失败、或重启导致事件重放，都会让同一个 taskId 的终态事件来第二次
  accountTerminalTask(t1.id, "failed", { error: "又超时" });
  check("重复终态事件不重复计数", getSchedule(s1.id)!.failCount === 1, String(getSchedule(s1.id)!.failCount));

  process.stdout.write("\n── 连续失败到阈值自动停用 ──\n");
  let last = getSchedule(s1.id)!;
  for (let i = last.failCount; i < LIMITS.maxConsecutiveFailures; i++) {
    const t = makeTask();
    dispatchedThenRestarted(s1.id, t.id);
    accountTerminalTask(t.id, "failed", { error: "继续失败" });
    last = getSchedule(s1.id)!;
  }
  check(
    `连续失败 ${LIMITS.maxConsecutiveFailures} 次即停用`,
    !last.enabled && last.failCount === LIMITS.maxConsecutiveFailures,
    `enabled=${last.enabled} failCount=${last.failCount}`,
  );
  check("停用时清掉退避（已经不再触发了）", !last.backoffUntil);

  process.stdout.write("\n── 成功清零失败计数与退避 ──\n");
  const s2 = makeSchedule("记账-成功");
  created.push(s2.id);
  const t2 = makeTask();
  dispatchedThenRestarted(s2.id, t2.id);
  accountTerminalTask(t2.id, "failed", { error: "先失败一次" });
  check("先攒下一次失败", getSchedule(s2.id)!.failCount === 1);
  const t3 = makeTask();
  dispatchedThenRestarted(s2.id, t3.id);
  accountTerminalTask(t3.id, "done", { result: "跑完了" });
  const after2 = getSchedule(s2.id)!;
  check("成功后 failCount 清零", after2.failCount === 0, String(after2.failCount));
  check("成功后退避清掉", !after2.backoffUntil);
  check("成功也要落记账标记（否则 then 后继会被重复派发）", after2.lastAccountedTaskId === t3.id);

  process.stdout.write("\n── 取消不算失败 ──\n");
  const s3 = makeSchedule("记账-取消");
  created.push(s3.id);
  const t4 = makeTask();
  dispatchedThenRestarted(s3.id, t4.id);
  accountTerminalTask(t4.id, "cancelled", {});
  const after3 = getSchedule(s3.id)!;
  check("取消不增加 failCount", after3.failCount === 0);
  check("取消也落记账标记", after3.lastAccountedTaskId === t4.id);

  process.stdout.write("\n── 单实例约束以任务真实状态为准 ──\n");
  const s4 = makeSchedule("单实例");
  created.push(s4.id);
  const t5 = makeTask();
  dispatchedThenRestarted(s4.id, t5.id);
  // 这里内存映射是空的（模拟重启），只能靠任务库判断
  check("在途任务仍在 → 判为还在跑，不叠第二个实例", stillRunning(getSchedule(s4.id)!));
  tm.markDone(CHAT, t5.id, "跑完了");
  check("任务已终态 → 判为可以再触发", !stillRunning(getSchedule(s4.id)!));
  const s5 = makeSchedule("单实例-从未跑过");
  created.push(s5.id);
  check("从未跑过 → 可以触发", !stillRunning(getSchedule(s5.id)!));

  process.stdout.write("\n── 不认领别人的任务 ──\n");
  const stray = makeTask();
  const before = getSchedule(s2.id)!.failCount;
  accountTerminalTask(stray.id, "failed", { error: "与任何 schedule 无关" });
  check("非定时任务的失败不记到任何 schedule 上", getSchedule(s2.id)!.failCount === before);

  process.stdout.write("\n── 依赖闸门：同一时间、一前一后 ──\n");
  const dep = makeSchedule("前置-复盘", { kind: "daily", hour: 21, minute: 0 });
  created.push(dep.id);
  const follower = makeSchedule("后继-优化", { kind: "weekly", weekday: 1, hour: 21, minute: 0 }, dep.id);
  created.push(follower.id);
  const plain = makeSchedule("无依赖", { kind: "daily", hour: 21, minute: 0 });
  created.push(plain.id);
  const now = new Date();

  check("没声明依赖 → free", dependencyGate(getSchedule(plain.id)!, now) === "free");
  check(
    "前置本轮还没触发 → waiting",
    dependencyGate(getSchedule(follower.id)!, now) === "waiting",
    dependencyGate(getSchedule(follower.id)!, now),
  );

  // 前置本轮跑起来了，但还没到终态
  const depTask = makeTask();
  updateSchedule(dep.id, { lastTaskId: depTask.id, lastRunKey: cycleKeyOf(dep, now) });
  check("前置在跑 → waiting", dependencyGate(getSchedule(follower.id)!, now) === "waiting");

  tm.markDone(CHAT, depTask.id, "复盘跑完了");
  check("前置到终态 → ready", dependencyGate(getSchedule(follower.id)!, now) === "ready");

  // 只看「前置最近一次成功」是不够的：跨周期的旧成功不能放行本轮
  updateSchedule(dep.id, { lastRunKey: "daily:1970-01-01" });
  check("前置上一周期的成功不算本轮 → waiting", dependencyGate(getSchedule(follower.id)!, now) === "waiting");
  updateSchedule(dep.id, { lastRunKey: cycleKeyOf(dep, now) });

  // 失败也算「结束」：否则前置一坏，下游就永久不跑（正是要避免的静默失效）
  const failTask = makeTask();
  updateSchedule(dep.id, { lastTaskId: failTask.id });
  tm.markFailed(CHAT, failTask.id, "复盘挂了");
  check("前置失败也算结束 → ready", dependencyGate(getSchedule(follower.id)!, now) === "ready");

  // 前置被停用 / 不存在：宁可不排序也要跑
  updateSchedule(dep.id, { enabled: false });
  check("前置被停用 → free", dependencyGate(getSchedule(follower.id)!, now) === "free");
  updateSchedule(dep.id, { enabled: true, lastRunKey: "daily:1970-01-01" });
  updateSchedule(follower.id, { dependsOn: "不存在的-id" });
  check("前置不存在 → free（不能静默永不执行）", dependencyGate(getSchedule(follower.id)!, now) === "free");
  updateSchedule(follower.id, { dependsOn: dep.id });

  // 等太久要放弃本轮，不能无限等
  updateSchedule(follower.id, {
    awaitingDep: { key: "weekly:2026-08-10", since: now.getTime() - LIMITS.depWaitMs - 1000 },
  });
  check("等超过上限 → giveup", dependencyGate(getSchedule(follower.id)!, now) === "giveup");
  updateSchedule(follower.id, {
    awaitingDep: { key: "weekly:2026-08-10", since: now.getTime() - 60_000 },
  });
  check("还没到上限 → 继续 waiting", dependencyGate(getSchedule(follower.id)!, now) === "waiting");

  cleanup(created);
  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

/**
 * 收尾清掉本 fixture 自己那个 chat 的任务库。
 *
 * **必须挂 process exit，不能用 finally**：实测 finally 清完之后还有写入把文件重建出来
 * —— check-handoff 的交接决策是 `void` 异步发出的，main 的 promise 结算后它们仍在跑，
 * 每次 tm.update 都会重新 persist。exit 事件在事件循环排空后触发，那时才真的没人再写。
 *
 * **只删自己这一个 chat**，绝不按 `fixture_*` 前缀批量删：并行跑多个 fixture 时
 * 那样会互相把对方的库删掉，表现是随机的断言失败，极难定位。
 */
process.on("exit", () => {
  dropChatTasks(CHAT);
  // 任务走终态钩子时会连带落一条工作台记录，只清任务库会留下 workbench 残留
  dropChatWorkbench(CHAT);
});

main();
