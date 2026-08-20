import { bossHandle } from "../boss/boss.js";
import { appendMessageLog } from "../core/logger.js";
import { describeActions } from "./card.js";
import type { ChannelMessage, ReplyFn } from "./types.js";

/**
 * 渠道统一主流程：全部委托给 Boss 分发层。
 * Boss 负责：意图分类 → 路由派发 → 任务队列/员工占用 → 待确认转发 → 汇报。
 * 队列与并发由 Boss 的 TaskManager 维护（不再在此做会话级串行）。
 * 进出消息统一落盘 logs/messages-YYYY-MM-DD.jsonl。
 * 返回的 Promise 在 boss 本轮分发完成后 resolve（后台任务不等待），且永不 reject。
 */
export function dispatchToAgent(msg: ChannelMessage, reply: ReplyFn): Promise<void> {
  appendMessageLog({
    time: new Date().toISOString(),
    direction: "in",
    channel: msg.channel,
    chatType: msg.chatType,
    chatId: msg.chatId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    text: msg.text,
  });

  // 包装回复通道：每条出站消息（含后台任务完成播报）都记日志。
  // 发送失败只记录不重抛（调用方多为 void reply(...)，重抛会变 unhandledRejection）
  const loggedReply: ReplyFn = async (text, card) => {
    const record = {
      time: new Date().toISOString(),
      direction: "out" as const,
      channel: msg.channel,
      chatType: msg.chatType,
      chatId: msg.chatId,
      text,
      ...(card ? { card: describeActions(card) } : {}),
    };
    try {
      await reply(text, card);
      appendMessageLog(record);
    } catch (error) {
      appendMessageLog({
        ...record,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("[channel] 回复发送失败:", error);
    }
  };

  return bossHandle(msg, loggedReply).catch((error) => {
    console.error("[channel] boss 处理异常:", error);
    void loggedReply(
      `处理出错：${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
