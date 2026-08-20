/**
 * Boss inbox 基础校验（零 LLM，纯断言）。
 *
 * 验证：
 * 1. 入队/消费基本流程
 * 2. 去抖合并
 * 3. 自激抑制
 * 4. classifier 分类
 * 5. budget 滚动窗口
 *
 * 用法：npx tsx server/boss/__fixtures__/check-inbox.ts
 */

import {
  enqueue,
  setInboxDrainHandler,
  markBossAction,
  clearBossActions,
  isSelfExcitation,
  _resetForTest,
  type InboxEvent,
  type SystemEventPayload,
} from "../inbox.js";
import { classifyEvent, type ChatState } from "../classifier.js";
import {
  canSystemTrigger,
  recordSystemTurn,
  _resetForTest as resetBudget,
  configureBudget,
} from "../budget.js";

let pass = 0;
const fails: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    process.stdout.write(`  \u2705 ${label}\n`);
  } else {
    fails.push(label);
    process.stdout.write(`  \u274C ${label}${detail ? ` — ${detail}` : ""}\n`);
  }
}

async function main(): Promise<void> {
  _resetForTest();
  resetBudget();

  // ─── 基本分类 ──
  process.stdout.write("\n── classifier 基本分类 ──\n");
  const chatState: ChatState = { assistUsed: 0, assistMax: 3 };

  const userEvent: InboxEvent = {
    id: "1",
    chatId: "c1",
    kind: "user_message",
    priority: "immediate",
    timestamp: Date.now(),
    payload: { msg: { channel: "cli", chatType: "private", chatId: "c1", senderId: "u1", text: "hi", raw: null }, reply: async () => {} },
  };
  check("user_message → awaken", classifyEvent(userEvent, chatState).action === "awaken");

  const taskCompleted: InboxEvent = {
    id: "2",
    chatId: "c1",
    kind: "task_completed",
    priority: "normal",
    timestamp: Date.now(),
    payload: { task: { id: "t1", chatId: "c1", agentName: "coder", state: "running" } as any, context: { output: "done" } },
  };
  check("task_completed → awaken", classifyEvent(taskCompleted, chatState).action === "awaken");

  const taskFailed: InboxEvent = {
    id: "3",
    chatId: "c1",
    kind: "task_failed",
    priority: "normal",
    timestamp: Date.now(),
    payload: { task: { id: "t2", chatId: "c1", agentName: "coder", state: "running" } as any, context: { errorText: "boom" } },
  };
  check("task_failed → awaken", classifyEvent(taskFailed, chatState).action === "awaken");

  // 自激事件
  const selfExcited: InboxEvent = {
    ...taskCompleted,
    id: "4",
    causedByBossAction: "complete_task",
  };
  check("带 causedByBossAction → suppress", classifyEvent(selfExcited, chatState).action === "suppress");

  // ─── 自激防护 ──
  process.stdout.write("\n── 自激防护 ──\n");
  markBossAction("c1", "retry_task");
  const selfEvent: InboxEvent = {
    id: "5",
    chatId: "c1",
    kind: "task_failed",
    priority: "normal",
    timestamp: Date.now(),
    payload: { task: { id: "t3", chatId: "c1", agentName: "a", state: "failed" } as any, context: {} },
    causedByBossAction: "retry_task",
  };
  check("isSelfExcitation 命中", isSelfExcitation(selfEvent));
  clearBossActions("c1");
  check("clearBossActions 后不再命中", !isSelfExcitation(selfEvent));

  // ─── budget ──
  process.stdout.write("\n── budget 滚动窗口 ──\n");
  configureBudget({ maxSystemTurnsPerHour: 3, maxSystemTokensPerHour: 10000, cooldownMs: 1000 });
  check("初始可触发", canSystemTrigger("c2"));
  recordSystemTurn("c2", 100);
  recordSystemTurn("c2", 100);
  check("2 次后仍可触发", canSystemTrigger("c2"));
  recordSystemTurn("c2", 100);
  check("3 次后不可触发（进入冷却）", !canSystemTrigger("c2"));

  // classifier 在 budget 耗尽时降级
  const degradedResult = classifyEvent(
    { ...taskCompleted, id: "6", chatId: "c2" },
    chatState,
  );
  check("budget 耗尽 → mechanical(review_fallback)", degradedResult.action === "mechanical" && "handler" in degradedResult && degradedResult.handler === "review_fallback");

  // ─── inbox 消费 ──
  process.stdout.write("\n── inbox 消费 ──\n");
  _resetForTest();
  resetBudget();

  let consumed: InboxEvent[][] = [];
  setInboxDrainHandler(async (events) => {
    consumed.push(events);
  });

  // user_message 立即触发（不去抖）
  enqueue({
    chatId: "c3",
    kind: "user_message",
    priority: "immediate",
    payload: { msg: { channel: "cli", chatType: "private", chatId: "c3", senderId: "u1", text: "test", raw: null }, reply: async () => {} },
  });

  // 等 drain（microtask）
  await new Promise((r) => setTimeout(r, 50));
  check("user_message 立即消费", consumed.length === 1 && consumed[0].length === 1);

  // 系统事件走去抖（500ms）
  consumed = [];
  enqueue({
    chatId: "c4",
    kind: "task_completed",
    priority: "normal",
    payload: { task: { id: "t10", chatId: "c4", agentName: "a", state: "done" } as any, context: {} },
  });
  enqueue({
    chatId: "c4",
    kind: "task_failed",
    priority: "normal",
    payload: { task: { id: "t11", chatId: "c4", agentName: "b", state: "failed" } as any, context: {} },
  });
  await new Promise((r) => setTimeout(r, 100));
  check("系统事件 100ms 后尚未消费（在去抖中）", consumed.length === 0);
  await new Promise((r) => setTimeout(r, 500));
  check("500ms 后合并消费（一批含 2 事件）", consumed.length === 1 && consumed[0].length === 2);

  report();
}

function report(): void {
  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

main();
