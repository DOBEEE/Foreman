import type { InboxEvent, InboxEventKind } from "./inbox.js";
import { canSystemTrigger } from "./budget.js";

/**
 * 显著性分类器。
 *
 * 纯确定性代码（零 LLM），决定一个事件是否值得唤醒完整 boss 大脑。
 * 分三档：awaken（唤醒完整推理循环）、mechanical（走确定性旧路径）、suppress（丢弃）。
 *
 * 设计纪律：这里只做分流，不做决策——"该怎么办"永远是 boss 的活。
 */

// ─── Types ────────────────────────────────────────────────────

export type ClassificationResult =
  | { action: "awaken"; reason: string }
  | { action: "mechanical"; handler: MechanicalHandler; reason: string }
  | { action: "suppress"; reason: string };

export type MechanicalHandler =
  | "escalate_to_user"      // employee_question 预算耗尽 → 直接上报
  | "diagnose_fallback"     // task_failed + boss 预算耗尽 → 旧 diagnoseFailure
  | "review_fallback"       // task_completed + boss 预算耗尽 → 旧 reviewEmployeeOutput
  | "handoff_fallback";     // handoff_needed + boss 预算耗尽 → 旧 resolveHandoff

export interface ChatState {
  /** 当前 chat 的 assist 预算已消耗次数 */
  assistUsed: number;
  assistMax: number;
}

// ─── Public API ───────────────────────────────────────────────

export function classifyEvent(event: InboxEvent, chatState: ChatState): ClassificationResult {
  // 自激事件在 inbox drain 阶段已过滤，这里不会收到，但防御性再判一次
  if (event.causedByBossAction) {
    return { action: "suppress", reason: `自激事件（${event.causedByBossAction}）` };
  }

  // 用户消息始终唤醒（不受 budget 限制）
  if (event.kind === "user_message") {
    return { action: "awaken", reason: "用户消息" };
  }

  // 系统事件先检查 budget
  if (!canSystemTrigger(event.chatId)) {
    return degradeForKind(event.kind);
  }

  // 按事件类型分流
  switch (event.kind) {
    case "task_completed":
      return { action: "awaken", reason: "员工交付，需验收" };

    case "task_failed":
      return { action: "awaken", reason: "任务失败，需决策" };

    case "handoff_needed":
      return { action: "awaken", reason: "前驱完成，需决定后继走向" };

    case "employee_question":
      if (chatState.assistUsed < chatState.assistMax) {
        return { action: "awaken", reason: "员工提问，尝试代答/上报" };
      }
      return { action: "mechanical", handler: "escalate_to_user", reason: "assist 预算耗尽" };

    case "schedule_alert":
      return { action: "awaken", reason: "定时任务异常" };

    case "capability_gap":
      return { action: "awaken", reason: "员工声明无法完成" };

    case "system_error":
      return { action: "awaken", reason: "基础设施错误，需判断影响面" };

    default: {
      const _exhaustive: never = event.kind;
      return { action: "suppress", reason: `未知事件类型 ${_exhaustive}` };
    }
  }
}

// ─── Internal ─────────────────────────────────────────────────

/** boss 预算耗尽时按事件类型选择降级路径 */
function degradeForKind(kind: InboxEventKind): ClassificationResult {
  switch (kind) {
    case "task_completed":
      return { action: "mechanical", handler: "review_fallback", reason: "boss 预算耗尽，降级到旧验收" };
    case "task_failed":
      return { action: "mechanical", handler: "diagnose_fallback", reason: "boss 预算耗尽，降级到旧诊断" };
    case "handoff_needed":
      return { action: "mechanical", handler: "handoff_fallback", reason: "boss 预算耗尽，降级到旧交接" };
    case "employee_question":
      return { action: "mechanical", handler: "escalate_to_user", reason: "boss 预算耗尽，直接上报" };
    case "schedule_alert":
    case "capability_gap":
      return { action: "suppress", reason: "boss 预算耗尽且非关键事件" };
    case "system_error":
      // 不降级到旧路径：crash-guard 已经把完整 stack 写进日志了，不会丢信息
      return { action: "suppress", reason: "boss 预算耗尽；错误已记入日志" };
    default:
      return { action: "suppress", reason: "boss 预算耗尽" };
  }
}
