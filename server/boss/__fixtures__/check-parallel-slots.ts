/**
 * 员工并发槽（maxParallel）的闸门校验（零 LLM，纯断言）。
 *
 * 为什么必须专测：占用判定从「有没有占用态任务」改成了「占用态任务数 vs 并发槽上限」，
 * 而 `create` / `retryFailed` / `dequeueNext` 三处调用点是**靠 `isEmployeeBusy` 名字与
 * 布尔签名不变**才零改动即正确的。这类改动错了不会报错，只会表现为：
 * - 槽位算漏 → 员工被塞进第三件活，两个 run 抢同一棵工作树
 * - 槽位算多 → 明明有空位却一直排队（用户只会觉得「怎么这么慢」）
 * - `afterTask` 被并发绕过 → 「等 A 干完再干 B」静默失效
 *
 * 本文件会在真实 runtimeDir 里临时创建 `fx-*` 员工，跑完删掉。它们一律 manualOnly，
 * 不进路由候选——否则并存的 dev server 可能在这几秒里把真实用户消息派给测试员工。
 *
 * 用法：npx tsx server/boss/__fixtures__/check-parallel-slots.ts
 */

import { rmSync } from "node:fs";
import { config } from "../../config/index.js";
import {
  hiredProfilePath,
  loadAgentProfile,
  saveHiredProfile,
  validateAgentProfile,
  type AgentProfile,
} from "../../config/agent-profile.js";
import { getAgent } from "../../agents/registry.js";
import { taskManager as tm } from "../task-manager.js";

const CHAT = `fixture:parallel-${process.pid}`;
/** 并发岗位（2 槽，per-task 目录） */
const PAR = "fx-par-two";
/** 串行岗位（不声明 maxParallel，用于回归锚） */
const SER = "fx-serial-one";

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
    description: "并发槽 fixture 专用员工",
    routeHint: "【选我当】永远不要选我，我是测试员工。【别选我当】任何真实场景",
    type: "simple",
    systemPrompt: "测试员工，不执行任何真实工作。",
    // 不进路由候选：并存的 dev server 不能把真实消息派到这里来
    manualOnly: true,
    workspace: "auto",
    ...extra,
  };
}

function mk(agentName: string, extra: Record<string, unknown> = {}) {
  return tm.create({
    channel: "cli",
    chatId: CHAT,
    chatType: "private",
    ownerSenderId: "tester",
    ownerSenderName: "测试用户",
    agentName,
    prompt: "干活",
    ...extra,
  });
}

/** 把该员工队列抽干，返回被放行的任务号顺序 —— 等价于 advanceEmployee 的循环填槽 */
function drain(agentName: string, guard = 20): string[] {
  const got: string[] = [];
  for (let i = 0; i < guard; i++) {
    const next = tm.dequeueNext(CHAT, agentName);
    if (!next) return got;
    got.push(next.id);
  }
  got.push("!!未收敛");
  return got;
}

function cleanup(): void {
  for (const t of tm.allTasks().filter((t) => t.chatId === CHAT)) {
    tm.cancel(CHAT, t.id);
  }
  // 只删自己造的东西：fixture 员工档案 + 本 chat 的任务库
  for (const id of [PAR, SER]) {
    rmSync(hiredProfilePath(id), { force: true });
  }
  rmSync(`${config.runtimeDir}/boss/${CHAT.replace(/[^\w-]/g, "_")}.json`, { force: true });
}

function main(): void {
  // 交接编排不在本层职责内（它有 check-handoff.ts）。不掐掉的话 markDone 会触发真实裁决。
  tm.setTerminalHook(() => {});

  process.stdout.write("\n── profile 校验 ──\n");
  const bad = (extra: Partial<AgentProfile>): string[] =>
    validateAgentProfile(profileOf("fx-probe", extra), true);
  check(
    "maxParallel>1 + per-chat → 拒绝（两个 run 会抢同一棵工作树）",
    bad({ maxParallel: 2, workspacePolicy: "per-chat" }).some((e) => e.includes("per-task")),
    bad({ maxParallel: 2, workspacePolicy: "per-chat" }).join("; "),
  );
  check(
    "maxParallel>1 + 未声明策略（= shared）→ 拒绝",
    bad({ maxParallel: 2 }).some((e) => e.includes("per-task")),
  );
  check(
    "maxParallel>1 + per-task → 通过",
    bad({ maxParallel: 2, workspacePolicy: "per-task" }).length === 0,
    bad({ maxParallel: 2, workspacePolicy: "per-task" }).join("; "),
  );
  check(
    "maxParallel>1 + per-run → 通过（用完即弃也不共享目录）",
    bad({ maxParallel: 3, workspacePolicy: "per-run" }).length === 0,
  );
  check(
    "maxParallel=1 + per-chat → 通过（串行岗位不受约束）",
    bad({ maxParallel: 1, workspacePolicy: "per-chat" }).length === 0,
  );
  check(
    "maxParallel 超过全局并发上限 → 拒绝（配了个假数字）",
    bad({ maxParallel: config.maxConcurrentRuns + 1, workspacePolicy: "per-task" }).some((e) =>
      e.includes("全局并发上限"),
    ),
  );
  check("maxParallel=0 → 拒绝", bad({ maxParallel: 0 }).some((e) => e.includes(">= 1")));
  check("maxParallel=1.5 → 拒绝", bad({ maxParallel: 1.5 }).some((e) => e.includes("整数")));

  saveHiredProfile(profileOf(PAR, { maxParallel: 2, workspacePolicy: "per-task" }));
  saveHiredProfile(profileOf(SER, {}));
  cleanupTasksOnly();

  process.stdout.write("\n── 回归锚：不声明 maxParallel 的岗位行为一字不变 ──\n");
  const s1 = mk(SER).task;
  check("第一件活直接 running", s1.state === "running", s1.state);
  const s2 = mk(SER);
  check("第二件活排队", s2.task.state === "queued" && s2.startNow === false, s2.task.state);
  check("排队期间 dequeueNext 取不到", tm.dequeueNext(CHAT, SER) === undefined);
  tm.markDone(CHAT, s1.id, "done");
  check("前一件结束后放行且只放一个", drain(SER).join(",") === s2.task.id, s2.task.id);

  process.stdout.write("\n── 2 槽岗位：两件同时跑，第三件排队 ──\n");
  const p1 = mk(PAR).task;
  const p2 = mk(PAR);
  check("第一件 running", p1.state === "running", p1.state);
  check("第二件也 running（吃掉第二个槽）", p2.task.state === "running", p2.task.state);
  check("此时空槽为 0", tm.freeSlots(CHAT, PAR) === 0, String(tm.freeSlots(CHAT, PAR)));
  const p3 = mk(PAR);
  check("第三件排队", p3.task.state === "queued", p3.task.state);
  check("槽满时 dequeueNext 取不到", tm.dequeueNext(CHAT, PAR) === undefined);
  check("occupyingTasks 报出全部 2 件（文案要如实）", tm.occupyingTasks(CHAT, PAR).length === 2);

  process.stdout.write("\n── 腾出一个槽只放行一件，不是全放 ──\n");
  const p5 = mk(PAR); // 队列里再压一件，这样「只放一个」才是真结论而不是「队列里只剩一个」
  check("槽满时继续排队", p5.task.state === "queued", p5.task.state);
  tm.markDone(CHAT, p1.id, "done");
  check("空槽变 1", tm.freeSlots(CHAT, PAR) === 1, String(tm.freeSlots(CHAT, PAR)));
  const drained = drain(PAR);
  check(
    "抽干队列只放行 1 件（最早那件）后即停，不超发、不无限循环",
    drained.length === 1 && drained[0] === p3.task.id,
    drained.join(","),
  );
  check("队列里较晚的那件仍在等", tm.get(CHAT, p5.task.id)?.state === "queued");

  process.stdout.write("\n── waiting_user 必须占槽 ──\n");
  cleanupTasksOnly();
  const w1 = mk(PAR).task;
  const w2 = mk(PAR).task;
  tm.markWaiting(CHAT, w1.id, "你要哪个方案？");
  check("等用户回答仍占槽（否则他一回话会同时醒来一堆）", tm.freeSlots(CHAT, PAR) === 0);
  const w3 = mk(PAR);
  check("两件都占着时新活排队", w3.task.state === "queued", w3.task.state);
  tm.cancel(CHAT, w2.id);
  check("取消一件后空出一个槽", tm.freeSlots(CHAT, PAR) === 1);
  check("放行排队的那件", drain(PAR).join(",") === w3.task.id);

  process.stdout.write("\n── afterTask 优先于并发：有空槽也不许抢跑 ──\n");
  cleanupTasksOnly();
  const dep = mk(PAR).task;
  const after = mk(PAR, { afterTask: dep.id });
  check("声明前置就排队（此刻明明还有空槽）", after.task.state === "queued", after.task.state);
  check("有空槽但前置未完成 → dequeueNext 跳过", tm.freeSlots(CHAT, PAR) === 1 && tm.dequeueNext(CHAT, PAR) === undefined);
  tm.markDone(CHAT, dep.id, "done");
  check("前置终态后才放行", drain(PAR).join(",") === after.task.id);

  process.stdout.write("\n── forceStart（定时任务）与槽位 ──\n");
  cleanupTasksOnly();
  const f1 = mk(PAR).task;
  const f2 = mk(PAR).task;
  check("2 槽已占满", tm.freeSlots(CHAT, PAR) === 0);
  const forced = mk(PAR, { forceStart: true });
  check(
    "声明了并发预算的岗位：定时任务也守槽位（否则 maxParallel 形同不存在）",
    forced.task.state === "queued",
    forced.task.state,
  );
  void f1;
  void f2;
  cleanupTasksOnly();
  const ser1 = mk(SER).task;
  const serForced = mk(SER, { forceStart: true });
  check(
    "未声明预算的岗位：定时任务保持历史语义（免排队，不回退）",
    serForced.task.state === "running",
    serForced.task.state,
  );
  void ser1;

  process.stdout.write("\n── latestSessionOf 不许在并发岗位上串会话 ──\n");
  cleanupTasksOnly();
  const sess = mk(PAR).task;
  tm.update(CHAT, sess.id, { sessionId: "sess-par" });
  check(
    "并发岗位返回 undefined（宁可新开会话也不接错上下文）",
    tm.latestSessionOf(CHAT, PAR) === undefined,
    String(tm.latestSessionOf(CHAT, PAR)),
  );
  const sess2 = mk(SER).task;
  tm.update(CHAT, sess2.id, { sessionId: "sess-ser" });
  check("串行岗位仍按原启发式返回", tm.latestSessionOf(CHAT, SER) === "sess-ser");

  process.stdout.write("\n── per-task 工作目录分桶 ──\n");
  const agent = getAgent(PAR);
  if (!agent) {
    check("能取到 fixture 员工实例", false);
  } else {
    const cwdA = agent.resolveRunCwd({ prompt: "x", params: { chatId: CHAT, taskId: "aaa111" } });
    const cwdA2 = agent.resolveRunCwd({ prompt: "y", params: { chatId: CHAT, taskId: "aaa111" } });
    const cwdB = agent.resolveRunCwd({ prompt: "x", params: { chatId: CHAT, taskId: "bbb222" } });
    const noTask = agent.resolveRunCwd({ prompt: "x", params: { chatId: CHAT } });
    check("同一任务两次解析到同一目录（跨轮要留住 clone 和分支）", cwdA === cwdA2, cwdA);
    check("不同任务解析到不同目录", cwdA !== cwdB, `${cwdA} vs ${cwdB}`);
    check("目录名带 task- 前缀（清理器按它识别）", cwdA.includes("/task-aaa111"), cwdA);
    check(
      "拿不到任务号时退化成 per-chat，而不是编一个（编了等于跨轮丢现场）",
      !noTask.includes("/task-") && cwdA.startsWith(`${noTask}/`),
      noTask,
    );
    const serAgent = getAgent(SER);
    const serCwd = serAgent?.resolveRunCwd({ prompt: "x", params: { chatId: CHAT, taskId: "aaa111" } });
    check("串行岗位（shared）不受影响，不分桶", serCwd != null && !serCwd.includes("/task-"), String(serCwd));
  }

  process.stdout.write("\n── 内置岗位的影分身声明真的生效 ──\n");
  for (const id of ["coder", "lead"]) {
    const p = loadAgentProfile(id);
    const errs = p ? validateAgentProfile(p, false) : ["读不到 profile"];
    check(`${id} 声明了影分身（maxParallel > 1）`, (p?.maxParallel ?? 1) > 1, String(p?.maxParallel));
    check(`${id} 的 workspacePolicy 是 per-task`, p?.workspacePolicy === "per-task", String(p?.workspacePolicy));
    check(`${id} 配置本身合法`, errs.length === 0, errs.join("; "));
    // lead 覆写了 run()，且曾经自带一份 resolveRunCwd（<workspacesRoot>/lead/<taskId>）。
    // 删掉那份覆写后必须确认它仍按任务隔离，否则两个并发编队会共用一个工作目录、
    // 互相覆盖产物，而组长的收尾复核只会看到「最后那个人留下的现场」。
    const a = getAgent(id);
    const c1 = a?.resolveRunCwd({ prompt: "x", params: { chatId: CHAT, taskId: "t1" } });
    const c2 = a?.resolveRunCwd({ prompt: "x", params: { chatId: CHAT, taskId: "t2" } });
    check(`${id} 两个并发任务解析到不同工作目录`, Boolean(c1 && c2 && c1 !== c2), `${c1} vs ${c2}`);
    check(`${id} 目录名带 task- 前缀（清理器按它识别，两套布局并存就会漏清）`, c1?.includes("/task-t1") === true, String(c1));
  }

  process.stdout.write(`\n━━━ ${pass}/${pass + fails.length} 通过 ━━━\n`);
  if (fails.length) {
    process.stdout.write(`未通过：${fails.join("、")}\n`);
    process.exitCode = 1;
  }
}

/** 只清任务、保留 fixture 员工档案（多段用例之间复用同一批员工） */
function cleanupTasksOnly(): void {
  for (const t of tm.allTasks().filter((t) => t.chatId === CHAT)) {
    tm.cancel(CHAT, t.id);
  }
}

try {
  main();
} finally {
  cleanup();
}
