/**
 * 任务依赖（等 A 干完再干 B）的出队闸门校验（零 LLM，纯断言）。
 *
 * 为什么必须专测：依赖任务和「等员工空」的任务**共用 queued 状态**（刻意的选择：新增
 * blocked 状态会让十余处按状态白名单判定的地方静默变坏）。区分两者的全部逻辑就落在
 * `dequeueNext` 那一道筛子上——筛漏了不会报错，只会表现为「B 提前跑了」，而且因为它
 * 用的是**原简报**，交接决策的改写/挂起/取消会全部落空且重复派发。
 *
 * 用法：npx tsx server/boss/__fixtures__/check-task-dep-queue.ts
 */

import { getAgent, listRoutableAgents } from "../../agents/registry.js";
import { opDispatchTask } from "../boss.js";
import { taskManager as tm } from "../task-manager.js";
import { dropChatTasks } from "../store.js";
import { dropChatWorkbench } from "../../core/workbench.js";

const CHAT = "fixture:task-dep";
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

/** promise 是否以异常收场 */
async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

function mk(agentName: string, extra: Parameters<typeof tm.create>[0] extends never ? never : Partial<Parameters<typeof tm.create>[0]> = {}) {
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

function cleanup(): void {
  for (const t of tm.allTasks().filter((t) => t.chatId === CHAT)) {
    tm.cancel(CHAT, t.id);
  }
}

async function main(): Promise<void> {
  // 本文件为了测派工校验 import 了 boss.ts，而 boss.ts **在模块加载时**就把交接编排接上了：
  // markDone 会触发真实交接裁决（要调模型）并顺手放行后继，把这里要断言的出队语义整个搅乱。
  // 交接有自己的 fixture（check-handoff.ts），这一层只测队列。
  tm.setTerminalHook(() => {});
  cleanup();

  process.stdout.write("\n── 声明前置就必须排队 ──\n");
  const a = mk("alice").task;
  check("无前置且员工空闲 → 直接 running", a.state === "running", a.state);
  // 关键：bob 此刻完全空闲，但声明了前置就不能开跑，否则「等 A 干完」等于没声明
  const created = mk("bob", { afterTask: a.id });
  const b = created.task;
  check("有前置即使员工空闲也排队", b.state === "queued", b.state);
  check("startNow 为 false", !created.startNow);
  check("依赖未满足", !tm.depSatisfied(b));
  check("不可开跑", !tm.startable(b));

  process.stdout.write("\n── 员工空闲事件不许抢跑 ──\n");
  // 这是本层的核心：bob 空着，advanceEmployee 会来问「有没有活可以派」
  check("前置未完成时 dequeueNext 不返回它", tm.dequeueNext(CHAT, "bob") === undefined);
  check("被跳过后仍是 queued（没被偷偷改状态）", tm.get(CHAT, b.id)?.state === "queued");

  process.stdout.write("\n── 前置到终态后放行 ──\n");
  tm.markDone(CHAT, a.id, "A 干完了");
  check("依赖已满足", tm.depSatisfied(tm.get(CHAT, b.id)!));
  const got = tm.dequeueNext(CHAT, "bob");
  check("dequeueNext 取到它", got?.id === b.id, String(got?.id));
  check("出队后置为 running", tm.get(CHAT, b.id)?.state === "running");

  process.stdout.write("\n── 交接闸期间不许抢跑 ──\n");
  const a2 = mk("alice").task;
  const b2 = mk("carol", { afterTask: a2.id }).task;
  tm.markDone(CHAT, a2.id, "干完");
  tm.update(CHAT, b2.id, { handoffPending: true });
  check("依赖满足但闸未开 → 不可开跑", !tm.startable(tm.get(CHAT, b2.id)!));
  check("闸未开时 dequeueNext 跳过", tm.dequeueNext(CHAT, "carol") === undefined);
  tm.update(CHAT, b2.id, { handoffPending: false });
  check("闸开后可出队", tm.dequeueNext(CHAT, "carol")?.id === b2.id);

  process.stdout.write("\n── 多后继按创建时间 ──\n");
  const a3 = mk("alice").task;
  const s1 = mk("dave", { afterTask: a3.id }).task;
  const s2 = mk("dave", { afterTask: a3.id }).task;
  const succ = tm.successorsOf(CHAT, a3.id);
  check("找得到全部后继", succ.length === 2, String(succ.length));
  check("顺序按 createdAt", succ[0].id === s1.id && succ[1].id === s2.id);
  tm.markDone(CHAT, a3.id, "干完");
  check("同员工的多后继一次只放一个（另一个继续排队）", tm.dequeueNext(CHAT, "dave")?.id === s1.id);
  check("第二个仍在队列里", tm.get(CHAT, s2.id)?.state === "queued");

  process.stdout.write("\n── 前置查不到时放行（宁可不排序也要跑）──\n");
  const orphan = mk("erin", { afterTask: "不存在的-id" }).task;
  check(
    "指向不存在的前置 → 依赖视为满足",
    tm.depSatisfied(tm.get(CHAT, orphan.id)!),
    "若在这里等下去，任务会退化成静默永不执行",
  );
  check("因此可以被出队", tm.dequeueNext(CHAT, "erin")?.id === orphan.id);

  process.stdout.write("\n── 前置失败 / 被取消也算终态 ──\n");
  const aF = mk("alice").task;
  const bF = mk("frank", { afterTask: aF.id }).task;
  tm.markFailed(CHAT, aF.id, "挂了");
  check("前置 failed 也算依赖满足", tm.depSatisfied(tm.get(CHAT, bF.id)!));
  const aC = mk("alice").task;
  const bC = mk("grace", { afterTask: aC.id }).task;
  tm.cancel(CHAT, aC.id);
  check("前置 cancelled 也算依赖满足", tm.depSatisfied(tm.get(CHAT, bC.id)!));

  process.stdout.write("\n── queuedCount 只数「等员工空」的 ──\n");
  // 它参与「他正忙，前面还有 N 个」文案，把等前置的算进去就是对用户说假话
  const busyA = mk("henry").task;
  check("占位任务在跑", busyA.state === "running");
  const waitEmployee = mk("henry").task;
  check("同员工第二个任务排队", waitEmployee.state === "queued");
  const pending = mk("alice").task;
  const waitDep = mk("henry", { afterTask: pending.id }).task;
  check("等前置的也是 queued", waitDep.state === "queued");
  check(
    "queuedCount 只算 1（等员工的那个）",
    tm.queuedCount(CHAT, "henry") === 1,
    String(tm.queuedCount(CHAT, "henry")),
  );

  process.stdout.write("\n── 派工时的顺序声明校验 ──\n");
  // 校验必须抛错而不是静默忽略：静默丢掉顺序后，boss 会照常告诉用户
  // 「安排好了，等 A 干完再跑 B」，而实际上 B 立刻就开跑了
  const anyAgent = listRoutableAgents()[0]?.name;
  if (!anyAgent) {
    check("有可路由员工可用于校验", false, "名册为空");
  } else {
    const candidate = getAgent(anyAgent)!;
    const msg = {
      channel: "cli",
      chatType: "private" as const,
      chatId: CHAT,
      senderId: "tester",
      senderName: "测试用户",
      text: "干活",
      raw: {},
    };
    // 必须给真实 candidates：传空数组会让 opDispatchTask 回落到 routeAgent（要调模型，
    // 候选为空还直接抛错），命中 preAgent 才走不到路由器
    const dispatch = (afterTask: string) =>
      opDispatchTask({ msg, content: "干活", candidates: [candidate], agent: anyAgent, afterTask });

    check("指向不存在的前置 → 抛错", await rejects(dispatch("不存在")), "必须让模型看见并纠正");
    const cancelled = mk("alice").task;
    tm.cancel(CHAT, cancelled.id);
    check("指向已取消的前置 → 抛错", await rejects(dispatch(cancelled.id)), "排在它后面永远等不到");

    // 前置已收尾 → 没什么可等的，退化成普通派工（不能建一个永远等不到交接的任务）。
    // 先占住目标员工，避免 startNow 触发真实 agent 运行。
    const doneDep = mk("alice").task;
    tm.markDone(CHAT, doneDep.id, "早就干完了");
    mk(anyAgent);
    const degraded = await dispatch(doneDep.id);
    check("前置已终态 → 退化为普通排队而非 waiting_dep", degraded.state === "queued", degraded.state);
    check("退化后不留 afterTask", tm.get(CHAT, degraded.taskId)?.afterTask === undefined);
  }

  cleanup();
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

void main();
