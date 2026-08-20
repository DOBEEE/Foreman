/**
 * 延后办工具常量与上下文类型。
 *
 * 实际 tool 实现在 server/runtime/tools/protocol-tools.ts (buildScheduleLaterTool)。
 * 本文件保留常量与 ScheduleToolContext 类型，供 base-agent 层引用。
 */

export const SCHEDULE_LATER_TOOL = "schedule_later";

/** 运行时上下文：由 base-agent 在每次 run 时注入（工具需要知道任务归属才能投递结果） */
export interface ScheduleToolContext {
  agentName: string;
  scheduled?: boolean;
  channel: string;
  chatId: string;
  chatType: "private" | "group";
  ownerSenderId: string;
  ownerSenderName: string;
}
