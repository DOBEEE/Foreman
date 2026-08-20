import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import { LOG_DIR, type MessageLogRecord } from "./logger.js";

/**
 * 会话（chat）消息持久化：把「用户 ↔ boss 的聊天记录」变成可查询的一等数据。
 *
 * 为什么需要它：boss 的对话上下文一直是靠复用 LLM session 实现的（boss-memory 存
 * chatId → sessionId），而聊天记录本身只以审计日志 logs/messages-*.jsonl 的形式存在，
 * 全代码库没有任何 reader。后台要做「多会话列表 + 切换 + 看历史」就没有数据可用。
 *
 * 放在 core/ 而不是 boss/：这是一个持久化设施（logger 要引它），不含 boss 业务逻辑，
 * 放 boss/ 会让 core → boss 形成反向依赖。
 */

/** 单条会话消息 */
export interface ChatMessage {
  at: number;
  /** in=用户发来的，out=boss/员工回复的 */
  direction: "in" | "out";
  senderId?: string;
  senderName?: string;
  text: string;
  /** out 带按钮卡片时的按钮标题摘要 */
  card?: string;
  /** out 发送失败时的错误 */
  error?: string;
}

/** 会话元信息：会话列表要展示的东西 */
export interface ChatMeta {
  chatId: string;
  channel: string;
  chatType: "private" | "group";
  /**
   * 会话标题。钉钉开放平台不给群名，只能用最近发言人聚合兜底，
   * 用户可通过 API 覆盖成人类可读的名字。
   */
  title?: string;
  lastMessageAt: number;
  lastText: string;
  messageCount: number;
  /** 参与过的发言人名（去重，最多留 10 个） */
  senders: string[];
  /**
   * 最近一条入站消息的发送者 staffId。
   *
   * 单聊的主动推送必须按人推（钉钉 oToMessages/batchSend 要 userIds），而历史上
   * 单聊会话的 chatId 存的是 conversationId 而不是 staffId，只靠 chatId 推不出去。
   */
  ownerSenderId?: string;
}

interface ChatFile {
  meta: ChatMeta;
  messages: ChatMessage[];
}

/**
 * 每个会话保留的消息条数上限。会话文件是整读整写的，无上限会让活跃群聊的文件无限膨胀，
 * 每来一条消息就要重写整个文件。超出则从头截断（老消息仍留在审计日志里可追溯）。
 */
const MAX_MESSAGES = 500;

/** 元信息里保留的发言人数上限 */
const MAX_SENDERS = 10;

let cachedDir: string | undefined;

function chatsDir(): string {
  // config 是带 mtime 检查的 Proxy，每条消息都读会频繁 statSync，这里缓存一次
  if (!cachedDir) cachedDir = join(config.runtimeDir, "chats");
  return cachedDir;
}

function safeKey(chatId: string): string {
  return chatId.replace(/[^\w-]/g, "_");
}

function fileOf(chatId: string): string {
  return join(chatsDir(), `${safeKey(chatId)}.json`);
}

/** 读一个会话的完整内容；不存在或损坏返回 undefined */
export function loadChat(chatId: string): ChatFile | undefined {
  try {
    const raw = readFileSync(fileOf(chatId), "utf-8");
    const parsed = JSON.parse(raw) as ChatFile;
    if (!parsed?.meta || !Array.isArray(parsed.messages)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeChat(chat: ChatFile): void {
  try {
    mkdirSync(chatsDir(), { recursive: true });
    writeFileSync(fileOf(chat.meta.chatId), `${JSON.stringify(chat, null, 2)}\n`, "utf-8");
  } catch (error) {
    console.warn("[chat-store] 写会话失败:", error);
  }
}

/** 把一条消息并入会话，返回更新后的会话（纯函数，便于回填复用） */
function mergeMessage(
  existing: ChatFile | undefined,
  chatId: string,
  channel: string,
  chatType: "private" | "group",
  msg: ChatMessage,
): ChatFile {
  const messages = [...(existing?.messages ?? []), msg];
  const senders = new Set(existing?.meta.senders ?? []);
  if (msg.direction === "in" && msg.senderName) senders.add(msg.senderName);
  // 入站消息才带发送者；出站消息不能把它清掉
  const ownerSenderId =
    msg.direction === "in" && msg.senderId ? msg.senderId : existing?.meta.ownerSenderId;
  return {
    meta: {
      chatId,
      channel,
      chatType,
      ...(existing?.meta.title ? { title: existing.meta.title } : {}),
      lastMessageAt: Math.max(existing?.meta.lastMessageAt ?? 0, msg.at),
      lastText: msg.text.slice(0, 200),
      messageCount: (existing?.meta.messageCount ?? 0) + 1,
      senders: [...senders].slice(0, MAX_SENDERS),
      ...(ownerSenderId ? { ownerSenderId } : {}),
    },
    messages: messages.slice(-MAX_MESSAGES),
  };
}

/**
 * 追加一条会话消息。永不抛出——聊天记录落盘失败不能影响消息投递本身。
 *
 * 由 appendMessageLog 统一调用：那是所有入站/出站消息的唯一收口
 * （channels/manager、boss/delivery、dingtalk/channel 全部经过它），
 * 在那里接线才能保证零遗漏。
 */
export function appendChatMessage(record: MessageLogRecord): void {
  try {
    const chatId = record.chatId;
    if (!chatId) return;
    const at = Date.parse(record.time) || Date.now();
    const chatType: "private" | "group" = record.chatType === "group" ? "group" : "private";
    const msg: ChatMessage = {
      at,
      direction: record.direction,
      ...(record.senderId ? { senderId: record.senderId } : {}),
      ...(record.senderName ? { senderName: record.senderName } : {}),
      text: record.text,
      ...(record.card ? { card: record.card } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
    writeChat(mergeMessage(loadChat(chatId), chatId, record.channel, chatType, msg));
  } catch (error) {
    console.warn("[chat-store] 追加会话消息失败:", error);
  }
}

/** 列出全部会话元信息，按最后消息时间倒序 */
export function listChatMetas(): ChatMeta[] {
  try {
    const dir = chatsDir();
    if (!existsSync(dir)) return [];
    const metas: ChatMeta[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf-8")) as ChatFile;
        if (parsed?.meta?.chatId) metas.push(parsed.meta);
      } catch {
        /* 单个文件损坏不影响其余会话 */
      }
    }
    return metas.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  } catch {
    return [];
  }
}

/** 读一个会话的消息（默认取最近 200 条） */
export function loadChatMessages(chatId: string, limit = 200): ChatMessage[] {
  const chat = loadChat(chatId);
  if (!chat) return [];
  return limit > 0 ? chat.messages.slice(-limit) : chat.messages;
}

/** 给会话设置人类可读的标题（钉钉拿不到群名，靠用户自己命名） */
export function setChatTitle(chatId: string, title: string): boolean {
  const chat = loadChat(chatId);
  if (!chat) return false;
  chat.meta.title = title.slice(0, 100);
  writeChat(chat);
  return true;
}

// ── 历史回填 ────────────────────────────────────────────

/** 回填完成标记：避免每次启动都重扫全部审计日志 */
function backfillMarker(): string {
  return join(chatsDir(), ".backfilled");
}

/**
 * 从审计日志 logs/messages-*.jsonl 一次性回填历史会话。
 *
 * 钉钉开放平台不允许机器人拉取历史消息，所以「把钉钉会话同步过来」只能靠我们自己
 * 早就在记的这份审计日志重建。幂等：完成后打标记，之后启动直接跳过。
 */
export function backfillFromMessageLogs(): { chats: number; messages: number } | undefined {
  try {
    if (existsSync(backfillMarker())) return undefined;
    if (!existsSync(LOG_DIR)) return undefined;

    const files = readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("messages-") && f.endsWith(".jsonl"))
      .sort(); // 按天升序，保证消息时序

    // 先在内存里按 chatId 聚合，最后一次性落盘（逐条 write 会重写文件上万次）
    const acc = new Map<string, ChatFile>();
    let messages = 0;
    for (const f of files) {
      let content: string;
      try {
        content = readFileSync(join(LOG_DIR, f), "utf-8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let record: MessageLogRecord;
        try {
          record = JSON.parse(line) as MessageLogRecord;
        } catch {
          continue; // 半行/损坏行跳过
        }
        if (!record?.chatId || !record.direction) continue;
        const at = Date.parse(record.time) || 0;
        const chatType: "private" | "group" =
          record.chatType === "group" ? "group" : "private";
        const msg: ChatMessage = {
          at,
          direction: record.direction,
          ...(record.senderId ? { senderId: record.senderId } : {}),
          ...(record.senderName ? { senderName: record.senderName } : {}),
          text: record.text ?? "",
          ...(record.card ? { card: record.card } : {}),
          ...(record.error ? { error: record.error } : {}),
        };
        acc.set(
          record.chatId,
          mergeMessage(acc.get(record.chatId), record.chatId, record.channel, chatType, msg),
        );
        messages++;
      }
    }

    mkdirSync(chatsDir(), { recursive: true });
    for (const chat of acc.values()) {
      // 已有会话文件的不覆盖（正常运行时写入的更权威）
      if (!existsSync(fileOf(chat.meta.chatId))) writeChat(chat);
    }
    writeFileSync(backfillMarker(), new Date().toISOString(), "utf-8");
    return { chats: acc.size, messages };
  } catch (error) {
    console.warn("[chat-store] 回填历史会话失败:", error);
    return undefined;
  }
}
