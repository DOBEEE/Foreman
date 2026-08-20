import type { Response } from "express";

/**
 * CLI/Web 渠道的 boss 消息推送通道：chatId → 订阅中的 SSE 连接集合。
 * boss 的所有出站消息（ack / 进度播报 / 待确认问题 / 验收汇报）经此广播，
 * 与钉钉的 sessionWebhook 推送同构——CLI 是一个「常驻 SSE」渠道。
 */
const streams = new Map<string, Set<Response>>();

export function subscribeBossPush(chatId: string, res: Response): () => void {
  let set = streams.get(chatId);
  if (!set) {
    set = new Set();
    streams.set(chatId, set);
  }
  set.add(res);
  return () => {
    set.delete(res);
    if (set.size === 0) streams.delete(chatId);
  };
}

/** 广播一条 boss 消息；无订阅者时静默丢弃（消息日志已在 manager 层落盘） */
export function pushBossMessage(chatId: string, text: string): void {
  const set = streams.get(chatId);
  if (!set || set.size === 0) return;
  const payload = `event: boss_message\ndata: ${JSON.stringify({ text, time: Date.now() })}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}
