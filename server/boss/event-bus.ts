import { EventEmitter } from "node:events";
import type { AgentEvent } from "../core/runner.js";
import type { BossDecisionRecord } from "../core/boss-log.js";
import type { Task, TaskState } from "./types.js";
import type { InboxEventKind } from "./inbox.js";

/**
 * Boss 事件总线：boss/任务生命周期 + agent 执行事件统一发布订阅。
 * - 单进程 in-process EventEmitter，Dashboard SSE 端订阅
 * - 不做持久化（历史回放走 traces log）
 * - 所有事件都带 taskId / chatId，UI 便于过滤
 */

export type BusEvent =
  | { kind: "task.created"; task: Task }
  | {
      kind: "task.state_change";
      taskId: string;
      chatId: string;
      from: TaskState;
      to: TaskState;
      task: Task;
    }
  | {
      /** 员工产出的运行事件（text / tool_call / tool_result / progress / thinking / result） */
      kind: "task.agent_event";
      taskId: string;
      chatId: string;
      agentName: string;
      event: AgentEvent;
    }
  | { kind: "task.done"; task: Task }
  | { kind: "task.failed"; task: Task }
  | { kind: "task.cancelled"; task: Task }
  | {
      /**
       * 主管自己的一次判断（分诊 / 代答裁决 / 验收 / 直答 / 兜底路由）。
       * taskId 可能为空——分诊与路由发生在任务创建之前，那时只有 chatId。
       */
      kind: "boss.decision";
      taskId?: string;
      chatId?: string;
      decision: BossDecisionRecord;
    };

const bus = new EventEmitter();
// dashboard 场景下可能同时开多个 SSE 连接（团队多人看板），把上限放大避免警告
bus.setMaxListeners(200);

const EVENT_NAME = "bus";

/**
 * 进行中任务的事件缓冲：taskId → 本轮已产生的 agent 事件。
 *
 * 为什么需要：trace 日志是在一轮 run **结束时**才落盘的（appendTraceLog 在 finally），
 * 所以任务正在跑时刷新 / 打开 Dashboard，历史事件无处可取，只能看到之后的实时流——
 * 表现就是「每次进来之前的都丢了」。这里在内存里留一份，SSE 连接时先补发。
 * 一轮结束（收到 result）即清除，之后由 trace 日志承担回放，避免双份。
 */
const LIVE_BUFFER_MAX = 400;
const liveEvents = new Map<string, AgentEvent[]>();

/** 取某任务当前轮的实时事件缓冲（SSE 连接时补发用） */
export function getLiveEvents(taskId: string): AgentEvent[] {
  return liveEvents.get(taskId) ?? [];
}

function bufferLiveEvent(taskId: string, event: AgentEvent): void {
  // result = 本轮收尾，trace 即将落盘 → 交棒给 trace 回放，清掉内存副本
  if (event.event === "result") {
    liveEvents.delete(taskId);
    return;
  }
  let list = liveEvents.get(taskId);
  if (!list) {
    list = [];
    liveEvents.set(taskId, list);
  }
  list.push(event);
  if (list.length > LIVE_BUFFER_MAX) list.splice(0, list.length - LIVE_BUFFER_MAX);
}

/** 发布一条事件 */
export function publish(event: BusEvent): void {
  if (event.kind === "task.agent_event") bufferLiveEvent(event.taskId, event.event);
  else if (
    event.kind === "task.done" ||
    event.kind === "task.failed" ||
    event.kind === "task.cancelled"
  ) {
    liveEvents.delete(event.task.id);
  }
  bus.emit(EVENT_NAME, event);
}

/**
 * 订阅事件。返回退订函数。
 * filter 可按 taskId / kind 过滤，减少无关事件传播。
 */
export function subscribe(
  handler: (event: BusEvent) => void,
  filter?: { taskId?: string; kinds?: BusEvent["kind"][] },
): () => void {
  const listener = (event: BusEvent) => {
    if (filter?.taskId) {
      if ("task" in event && event.task.id !== filter.taskId) return;
      if ("taskId" in event && event.taskId !== filter.taskId) return;
    }
    if (filter?.kinds && !filter.kinds.includes(event.kind)) return;
    try {
      handler(event);
    } catch (e) {
      console.warn("[event-bus] handler 抛错，已忽略:", e);
    }
  };
  bus.on(EVENT_NAME, listener);
  return () => bus.off(EVENT_NAME, listener);
}

/** 便捷发布：任务创建 */
export function publishCreated(task: Task): void {
  publish({ kind: "task.created", task });
}

/** 便捷发布：状态迁移 */
export function publishStateChange(task: Task, from: TaskState): void {
  publish({
    kind: "task.state_change",
    taskId: task.id,
    chatId: task.chatId,
    from,
    to: task.state,
    task,
  });
}

/** 便捷发布：一次 agent 执行事件（runWorker 转发用） */
export function publishAgentEvent(
  task: Task,
  event: AgentEvent,
): void {
  publish({
    kind: "task.agent_event",
    taskId: task.id,
    chatId: task.chatId,
    agentName: task.agentName,
    event,
  });
}

/** 便捷发布：主管的一次判断（bossThink 落盘后转发） */
export function publishBossDecision(decision: BossDecisionRecord): void {
  publish({
    kind: "boss.decision",
    ...(decision.taskId ? { taskId: decision.taskId } : {}),
    ...(decision.chatId ? { chatId: decision.chatId } : {}),
    decision,
  });
}

/**
 * 将 event-bus 的任务终态事件桥接到 inbox。
 *
 * 由 boss 启动时（initBossInbox 之后）调用一次。
 * 只转发 task.done / task.failed — 其余终态（cancelled）由用户动作触发，
 * boss 已在那条路径上处理过，不需要二次唤醒。
 *
 * 注意：这里只是把信号投递到 inbox；实际决策由 inbox drain → classifier → boss 完成。
 * 如果 runWorker 内部已经通过 emitSystemEvent 投递了（未来的主路径），
 * 这里的事件会被 inbox 的去重/去抖机制合并，不会重复唤醒。
 */
export function bridgeEventBusToInbox(
  emitFn: (kind: InboxEventKind, task: Task, context: Record<string, unknown>) => void,
): () => void {
  return subscribe((event) => {
    if (event.kind === "task.done") {
      emitFn("task_completed", event.task, {
        output: event.task.result ?? "",
        agentDisplay: event.task.agentName,
        acceptance: (event.task as unknown as Record<string, unknown>).acceptance ?? "",
      });
    } else if (event.kind === "task.failed") {
      emitFn("task_failed", event.task, {
        errorText: event.task.error ?? "未知错误",
        agentDisplay: event.task.agentName,
        retries: (event.task as unknown as Record<string, unknown>).errorRetries ?? 0,
        remaining: 0,
      });
    }
  }, { kinds: ["task.done", "task.failed"] });
}
