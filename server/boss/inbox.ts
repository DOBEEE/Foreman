import { randomUUID } from "node:crypto";
import type { ChannelMessage, ReplyFn } from "../channels/types.js";
import type { Task } from "./types.js";

/**
 * Boss 事件收件箱。
 *
 * 所有触发源（用户消息、任务终态、调度异常）不再各自直接唤醒 boss 或调 bossThink，
 * 而是投递到这里。inbox 负责：
 *   1. 按 chatId 串行化（同一会话只有一个 boss 轮次在跑）
 *   2. 去抖合并：500ms 内同 chatId 多事件合成一次唤醒
 *   3. 自激防护：boss 动作产生的事件不重新唤醒自己
 *   4. 优先级排序：用户消息 > 系统事件
 *
 * 不持久化：事件本质是瞬态（任务已持久化），重启后靠 recovery 补漏。
 */

// ─── Types ────────────────────────────────────────────────────

export type InboxEventKind =
  | "user_message"
  | "task_completed"
  | "task_failed"
  | "handoff_needed"
  | "employee_question"
  | "schedule_alert"
  | "capability_gap"
  | "system_error";

export interface UserMessagePayload {
  msg: ChannelMessage;
  reply: ReplyFn;
}

export interface SystemEventPayload {
  task: Task;
  /** 事件特有数据（如产出文本、错误信息、验收标准等） */
  context: Record<string, unknown>;
}

/**
 * 基础设施错误（全局崩溃兜底捕获的）。
 *
 * 与 SystemEventPayload 分开是因为它**没有绑定任务**——一次 MCP server 超时
 * 或未捕获异常不属于任何一个任务，投递目标只能是系统级通知落点（notifyTarget）。
 */
export interface InfraEventPayload {
  source: "unhandled_rejection" | "uncaught_exception";
  /** 错误文本（已截断） */
  errorText: string;
  /** 同一错误签名在窗口内的累计出现次数 */
  occurrences: number;
  context: Record<string, unknown>;
}

export interface InboxEvent {
  id: string;
  chatId: string;
  kind: InboxEventKind;
  priority: "immediate" | "normal" | "low";
  timestamp: number;
  payload: UserMessagePayload | SystemEventPayload | InfraEventPayload;
  /** boss 动作导致的事件带此标记，分类器据此抑制 */
  causedByBossAction?: string;
}

// ─── Inbox State ──────────────────────────────────────────────

/** 每个 chat 的待消费事件队列 */
const queues = new Map<string, InboxEvent[]>();

/** 去抖 timer per chat：500ms 窗口内聚合多事件为一次唤醒 */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 串行化 promise chain per chat（与 boss.ts withChatLock 同一模式） */
const drainChains = new Map<string, Promise<void>>();

/** 当前正在执行的 boss turn 的 action id（用于自激判定） */
const activeTurnActions = new Map<string, Set<string>>();

/** 消费回调：由 boss 主流程注册 */
let drainHandler: ((events: InboxEvent[]) => Promise<void>) | undefined;

// ─── Configuration ────────────────────────────────────────────

const DEBOUNCE_MS = 500;

// ─── Public API ───────────────────────────────────────────────

/** 注册消费者（全局唯一，由 boss 启动时调用） */
export function setInboxDrainHandler(handler: (events: InboxEvent[]) => Promise<void>): void {
  drainHandler = handler;
}

/** 投递事件到 inbox */
export function enqueue(event: Omit<InboxEvent, "id" | "timestamp">): void {
  const full: InboxEvent = {
    ...event,
    id: randomUUID(),
    timestamp: Date.now(),
  };
  const queue = queues.get(full.chatId) ?? [];
  queue.push(full);
  queues.set(full.chatId, queue);

  // 用户消息立即触发（不去抖，保持响应性）
  if (full.kind === "user_message") {
    clearDebounce(full.chatId);
    scheduleDrain(full.chatId, 0);
    return;
  }

  // 系统事件走去抖
  if (!debounceTimers.has(full.chatId)) {
    scheduleDrain(full.chatId, DEBOUNCE_MS);
  }
}

/** 标记当前 boss turn 执行了哪些动作（入 activeTurnActions，供自激判定用） */
export function markBossAction(chatId: string, actionName: string): void {
  const set = activeTurnActions.get(chatId) ?? new Set();
  set.add(actionName);
  activeTurnActions.set(chatId, set);
}

/** 清理当前 turn 标记（turn 结束时调） */
export function clearBossActions(chatId: string): void {
  activeTurnActions.delete(chatId);
}

/** 判断事件是否为自激（boss 自己的动作产生的） */
export function isSelfExcitation(event: InboxEvent): boolean {
  if (!event.causedByBossAction) return false;
  const active = activeTurnActions.get(event.chatId);
  return active?.has(event.causedByBossAction) ?? false;
}

/** 获取某 chat 当前队列深度（供 situation 展示） */
export function inboxDepth(chatId: string): number {
  return queues.get(chatId)?.length ?? 0;
}

/** 测试用：重置全部状态 */
export function _resetForTest(): void {
  queues.clear();
  debounceTimers.forEach(clearTimeout);
  debounceTimers.clear();
  drainChains.clear();
  activeTurnActions.clear();
}

// ─── Internal ─────────────────────────────────────────────────

function clearDebounce(chatId: string): void {
  const timer = debounceTimers.get(chatId);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(chatId);
  }
}

function scheduleDrain(chatId: string, delayMs: number): void {
  clearDebounce(chatId);
  if (delayMs <= 0) {
    void drain(chatId);
    return;
  }
  debounceTimers.set(
    chatId,
    setTimeout(() => {
      debounceTimers.delete(chatId);
      void drain(chatId);
    }, delayMs),
  );
}

/**
 * 消费一个 chat 的队列。串行化保证同一 chat 同时只有一个 boss turn。
 * 优先级排序：immediate > normal > low；同优先级内按 timestamp。
 */
function drain(chatId: string): Promise<void> {
  const prev = drainChains.get(chatId) ?? Promise.resolve();
  const run = prev.then(() => doDrain(chatId)).catch(() => undefined);
  drainChains.set(chatId, run);
  return run;
}

async function doDrain(chatId: string): Promise<void> {
  const queue = queues.get(chatId);
  if (!queue?.length) return;

  // 取出全部事件，按优先级+时间排序
  const batch = queue.splice(0, queue.length);
  if (queue.length === 0) queues.delete(chatId);

  // 过滤自激事件
  const filtered = batch.filter((e) => !isSelfExcitation(e));
  if (filtered.length === 0) return;

  // 按优先级分组排序
  const priorityOrder = { immediate: 0, normal: 1, low: 2 };
  filtered.sort((a, b) => {
    const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
    return pd !== 0 ? pd : a.timestamp - b.timestamp;
  });

  if (!drainHandler) {
    console.warn("[inbox] 没有注册消费者，丢弃事件", filtered.map((e) => e.kind));
    return;
  }

  try {
    await drainHandler(filtered);
  } catch (err) {
    console.error("[inbox] drain 执行失败", err);
  }
}
