/**
 * 串行交接（前置干完后决定后继怎么走）的结构性校验（零 LLM，纯断言）。
 *
 * 为什么必须专测：这一层全是**竞态与幂等**，失效时不报错只表现为「活丢了」或「跑了两遍」。
 * 已知的坑都在这里钉住：
 * - 打闸不同步 → `advanceEmployee` 用原简报抢跑，改写/挂起/取消全部落空
 * - 缺幂等位 → 验收返工、`retryFailed` 会重放终态，后继被派两次（scheduler 栽过同一类）
 * - 裁决失败回落 hold → 用户不知道有个任务在等他回话，静默卡死
 * - 前置失败时让模型决定 drop → `retry_task` 复活前置后，后继永久消失
 *
 * 用法：npx tsx server/boss/__fixtures__/check-handoff.ts
 */

import {
  defaultHandoffDecider,
  markSuccessorsPending,
  onTaskTerminal,
  recoverPendingHandoffs,
  resolveReviewer,
  setHandoffRuntime,
  withUpstreamOutput,
  type HandoffDecision,
} from "../handoff.js";
import { taskManager as tm } from "../task-manager.js";
import type { Task } from "../types.js";
import { dropChatTasks } from "../store.js";
import { dropChatWorkbench } from "../../core/workbench.js";

const CHAT = "fixture:handoff";
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

/** 记录副作用，替代真实投递/派发 */
const log: { said: string[]; advanced: string[]; held: Array<{ id: string; q: string }> } = {
  said: [],
  advanced: [],
  held: [],
};

let nextDecision: HandoffDecision = { action: "go" };
/** 让下一次裁决抛错（模拟网关 429），单独一个开关避免污染 nextDecision 的类型 */
let throwNext = false;
let decideCalls = 0;

function resetLog(): void {
  log.said = [];
  log.advanced = [];
  log.held = [];
  decideCalls = 0;
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
    brief: "目标：原始简报",
    ...extra,
  } as Parameters<typeof tm.create>[0]).task;
}

function cleanup(): void {
  for (const t of tm.allTasks().filter((t) => t.chatId === CHAT)) tm.cancel(CHAT, t.id);
}

/** 等异步裁决落地（onTaskTerminal 是 fire-and-forget） */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

async function main(): Promise<void> {
  // 生产环境这行在 boss.ts（连同 effects 一起接线）。本测试刻意不加载 boss.ts——
  // 那会拖进渠道投递、并发闸、runWorker 整条依赖，而这里要断言的只是编排判断本身。
  tm.setTerminalHook(onTaskTerminal);
  setHandoffRuntime({
    effects: {
      say: (task, text) => log.said.push(`${task.id}:${text}`),
      advance: (_chatId, agentName) => log.advanced.push(agentName),
      hold: (task, q) => log.held.push({ id: task.id, q }),
    },
    decider: async () => {
      decideCalls++;
      if (throwNext) throw new Error("网关 429");
      return nextDecision;
    },
  });
  cleanup();

  process.stdout.write("\n── 打闸必须同步（否则被抢跑）──\n");
  const a1 = mk("alice");
  const b1 = mk("bob", { afterTask: a1.id });
  const flagged = markSuccessorsPending(a1);
  check("找到并打闸", flagged.length === 1 && tm.get(CHAT, b1.id)?.handoffPending === true);
  check("打闸后 dequeueNext 抢不到", tm.dequeueNext(CHAT, "bob") === undefined);
  tm.update(CHAT, b1.id, { handoffPending: false });

  process.stdout.write("\n── go：放行 + 注入上游产出 ──\n");
  resetLog();
  nextDecision = { action: "go" };
  tm.markDone(CHAT, a1.id, "上游结论：入口在 src/index.ts");
  await settle();
  const afterGo = tm.get(CHAT, b1.id)!;
  check("裁决被调用一次", decideCalls === 1, String(decideCalls));
  check("清掉 afterTask（这是幂等的真正来源）", afterGo.afterTask === undefined);
  check("闸已放开", !afterGo.handoffPending);
  check("落了决策时刻", typeof afterGo.handoffResolvedAt === "number");
  check("简报里注入了上游产出", afterGo.brief!.includes("src/index.ts"), afterGo.brief);
  check("保留了原简报", afterGo.brief!.includes("原始简报"));
  check("推进了后继员工的队列", log.advanced.includes("bob"), JSON.stringify(log.advanced));
  check("向用户播报了接续", log.said.some((s) => s.includes("接着跑")), JSON.stringify(log.said));

  process.stdout.write("\n── 幂等：终态重放不许再派一次 ──\n");
  resetLog();
  // 验收返工会让任务多次进出 running，retryFailed 也会重放终态
  onTaskTerminal(tm.get(CHAT, a1.id)!, "done");
  await settle();
  check("不再触发裁决", decideCalls === 0, String(decideCalls));
  check("不再推进队列", log.advanced.length === 0, JSON.stringify(log.advanced));

  process.stdout.write("\n── revise：按改写后的简报派 ──\n");
  resetLog();
  const a2 = mk("alice");
  const b2 = mk("bob", { afterTask: a2.id });
  nextDecision = { action: "revise", brief: "目标：改写后的简报", reason: "上游给了具体路径" };
  tm.markDone(CHAT, a2.id, "路径是 src/app.ts");
  await settle();
  const revised = tm.get(CHAT, b2.id)!;
  check("用了新简报", revised.brief!.includes("改写后的简报"), revised.brief);
  check("旧简报被替换掉", !revised.brief!.includes("原始简报"));
  check("同样注入上游产出", revised.brief!.includes("src/app.ts"));
  check("播报里说明简报改过", log.said.some((s) => s.includes("订正")), JSON.stringify(log.said));

  process.stdout.write("\n── hold：挂起问用户，不放行 ──\n");
  resetLog();
  const a3 = mk("alice");
  const b3 = mk("bob", { afterTask: a3.id });
  nextDecision = { action: "hold", question: "前提变了，还做吗？" };
  tm.markDone(CHAT, a3.id, "结论");
  await settle();
  check("走了挂起", log.held.some((h) => h.id === b3.id), JSON.stringify(log.held));
  check("没有推进队列", !log.advanced.includes("bob"), JSON.stringify(log.advanced));
  check("闸放开了（否则用户回答后也动不了）", !tm.get(CHAT, b3.id)?.handoffPending);

  process.stdout.write("\n── drop：取消后继 ──\n");
  resetLog();
  const a4 = mk("alice");
  const b4 = mk("bob", { afterTask: a4.id });
  nextDecision = { action: "drop", reason: "上游已经把这件事做掉了" };
  tm.markDone(CHAT, a4.id, "顺手也做了 B 的事");
  await settle();
  check("后继被取消", tm.get(CHAT, b4.id)?.state === "cancelled", tm.get(CHAT, b4.id)?.state);
  check("没有推进队列", !log.advanced.includes("bob"));
  check("说明了原因", log.said.some((s) => s.includes("上游已经把这件事做掉了")), JSON.stringify(log.said));

  process.stdout.write("\n── 三级链：drop 中间那个，末级不许永久排队 ──\n");
  resetLog();
  const x = mk("alice");
  const y = mk("bob", { afterTask: x.id });
  const z = mk("carol", { afterTask: y.id });
  nextDecision = { action: "drop", reason: "不用做了" };
  tm.markDone(CHAT, x.id, "产出");
  await settle();
  check("中间那级被取消", tm.get(CHAT, y.id)?.state === "cancelled");
  check(
    "末级没有卡在 queued（这才是级联要解决的问题）",
    tm.get(CHAT, z.id)?.state !== "queued",
    tm.get(CHAT, z.id)?.state,
  );
  check("末级被处理过（有裁决记录）", tm.get(CHAT, z.id)?.handoffResolvedAt != null);

  process.stdout.write("\n── 默认裁决器：前置没成功一律交回用户（零模型调用）──\n");
  // 这条规则必须在这里测，不能靠上面的 stub：它是**默认裁决器**的早返回，
  // 发生在调模型之前。为什么不让模型决定——失败可被 retry_task 复活，一旦它判 drop，
  // 前置重试成功后这个后继就永久消失了，活丢了没人知道。
  for (const to of ["failed", "cancelled"] as const) {
    const d = await defaultHandoffDecider({
      predecessor: { ...mk("alice"), state: to } as Task,
      successor: mk("bob"),
      to,
    });
    check(`前置 ${to} → hold`, d.action === "hold", d.action);
    check(`前置 ${to} 时带上问用户的话`, Boolean(d.question?.trim()));
  }

  process.stdout.write("\n── 裁决失败：回落 go，不回落 hold ──\n");
  resetLog();
  const a5 = mk("alice");
  const b5 = mk("bob", { afterTask: a5.id });
  throwNext = true;
  tm.markDone(CHAT, a5.id, "上游产出 X");
  await settle();
  throwNext = false;
  check("仍然放行（hold 会让用户完全不知道有活在等）", log.advanced.includes("bob"), JSON.stringify(log.advanced));
  check("没有挂起", log.held.length === 0);
  check("依赖已清", tm.get(CHAT, b5.id)?.afterTask === undefined);
  check("上游产出照样注入", tm.get(CHAT, b5.id)!.brief!.includes("上游产出 X"));

  process.stdout.write("\n── 期间被用户手动取消的后继不再处理 ──\n");
  resetLog();
  nextDecision = { action: "go" };
  const a6 = mk("alice");
  const b6 = mk("bob", { afterTask: a6.id });
  tm.cancel(CHAT, b6.id);
  tm.markDone(CHAT, a6.id, "产出");
  await settle();
  check("不对已取消的后继做裁决", decideCalls === 0, String(decideCalls));
  check("不推进队列", log.advanced.length === 0);

  process.stdout.write("\n── 没有后继时零开销 ──\n");
  resetLog();
  const lone = mk("alice");
  tm.markDone(CHAT, lone.id, "产出");
  await settle();
  check("不调裁决", decideCalls === 0);
  check("不播报", log.said.length === 0, JSON.stringify(log.said));

  process.stdout.write("\n── withUpstreamOutput ──\n");
  const noResult = { ...lone, result: "" } as Task;
  check("上游无产出时原样返回", withUpstreamOutput("简报", noResult) === "简报");
  const withOut = withUpstreamOutput("简报", { ...lone, result: "结论 Y" } as Task);
  check("有产出时拼接", withOut.includes("简报") && withOut.includes("结论 Y"));
  check("标明了来源任务号", withOut.includes(`#${lone.id}`));

  process.stdout.write("\n── resolveReviewer：谁来验收 ──\n");
  const coderTask = { ...mk("coder") } as Task;
  check(
    "岗位配置声明了就用它",
    resolveReviewer(coderTask) === "code-review",
    String(resolveReviewer(coderTask)),
  );
  const plainTask = { ...mk("assistant") } as Task;
  check(
    "没声明 → 不派验收员（降级到硬校验 + 协议闸）",
    resolveReviewer(plainTask) === undefined,
    String(resolveReviewer(plainTask)),
  );
  check(
    "任务上的一次性指定优先于岗位配置",
    resolveReviewer({ ...coderTask, reviewer: "assistant" } as Task) === "assistant",
  );
  // builtin 的 default 指向随 presets 发布的 code-review，没装 presets 的环境这条是悬挂的；
  // 用户也可能把评审岗删掉。必须降级而不是抛错。
  check(
    "指向不存在的员工 → 降级为不派",
    resolveReviewer({ ...coderTask, reviewer: "根本没有这个岗位" } as Task) === undefined,
  );
  // 一次性指定走模型填参，绕过了 profile 那道「不得等于自己」的校验
  check(
    "评审人等于执行者 → 降级为不派",
    resolveReviewer({ ...coderTask, reviewer: "coder" } as Task) === undefined,
  );

  process.stdout.write("\n── 重启补交接（最容易出现的静默失效）──\n");
  resetLog();
  nextDecision = { action: "go" };
  // 模拟宕机：摘掉钩子后改前置状态，等于「终态发生了但没人处理」
  tm.setTerminalHook(() => {});
  const rA = mk("alice");
  const rB = mk("bob", { afterTask: rA.id });
  tm.markDone(CHAT, rA.id, "宕机前就干完了");
  check("宕机后后继仍停在 queued", tm.get(CHAT, rB.id)?.state === "queued");
  check("这时它其实已可开跑（只差有人推它）", tm.startable(tm.get(CHAT, rB.id)!));
  tm.setTerminalHook(onTaskTerminal);
  const recovered = recoverPendingHandoffs();
  await settle();
  check("补触发了一条", recovered === 1, String(recovered));
  check("后继被放行", log.advanced.includes("bob"), JSON.stringify(log.advanced));
  check("依赖已清", tm.get(CHAT, rB.id)?.afterTask === undefined);
  check("再跑一次不重复补（已决策过）", recoverPendingHandoffs() === 0);

  // 残留的闸：给它打闸的那个决策进程已经不在了，不清就永远开不了
  const sA = mk("alice");
  const sB = mk("bob", { afterTask: sA.id });
  tm.update(CHAT, sB.id, { handoffPending: true });
  tm.setTerminalHook(() => {});
  tm.markDone(CHAT, sA.id, "干完");
  tm.setTerminalHook(onTaskTerminal);
  recoverPendingHandoffs();
  await settle();
  check("残留的 handoffPending 被清掉", !tm.get(CHAT, sB.id)?.handoffPending);

  resetLog();
  const pA = mk("alice");
  mk("bob", { afterTask: pA.id });
  check("前置还没收尾的不动它", recoverPendingHandoffs() === 0);
  check("也不调裁决", decideCalls === 0);

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
