import { describeActions, type OutboundCard } from "../channels/card.js";
import { pushBossMessage } from "../api/boss-push.js";
import { appendMessageLog } from "../core/logger.js";
import { resolvePrivateChatId } from "../core/identity.js";
import { config } from "../config/index.js";
import {
  CLI_DEFAULT_CHAT_ID,
  DEFAULT_CHANNEL_TYPE,
  type DeliveryTarget,
  type ReplyFn,
} from "../channels/types.js";

/**
 * boss 出站消息的统一投递层。
 *
 * 为什么需要它：活跃会话的 reply 闭包（钉钉 sessionWebhook / CLI 的当次 SSE）是**易失**的——
 * 进程重启即丢，webhook 本身也会过期。而定时任务、后台长任务的结论往往在数小时后才产生，
 * 那时原 reply 早已失效，消息会静默丢失。
 *
 * 投递顺序：活跃会话 reply → 渠道主动推送（Channel.push）→ 仅落日志。
 */

/**
 * 投递目标定义在渠道层（`Channel.push` 要用），这里再导出一次是为了不惊动既有 import 站点。
 */
export type { DeliveryTarget };

/**
 * 系统级主动推送的目标，按序取第一个可用：群 → 单聊 → CLI 会话。
 *
 * 从 scheduler 迁到这里：复盘/优化/归纳/一层回归都要用它，而放在 scheduler 会让
 * 「被调度的东西」反过来 import 调度器，形成循环依赖。投递目标本来就是 delivery 的概念。
 * 复用 config.retro 的通知配置——四条系统推送共用一个落点，三份同样的回落逻辑必然漂移。
 *
 * 渠道不写死在这里：用 DEFAULT_CHANNEL_TYPE。`notifyChat` / `notifyUser` 配的是那个渠道里的
 * 会话 id / 工号，与渠道类型是绑定关系，所以不额外让用户再配一次渠道。
 */
export function notifyTarget(): Required<Pick<DeliveryTarget, "channel" | "chatId" | "chatType" | "ownerSenderId">> {
  const { notifyChat, notifyUser } = config.retro;
  if (notifyChat) {
    return {
      channel: DEFAULT_CHANNEL_TYPE,
      chatId: notifyChat,
      chatType: "group",
      ownerSenderId: "",
    };
  }
  if (notifyUser) {
    const id = notifyUser.split(",")[0].trim();
    return {
      channel: DEFAULT_CHANNEL_TYPE,
      chatId: id,
      chatType: "private",
      ownerSenderId: id,
    };
  }
  // 都没配外部渠道：落回本机 CLI 会话。过一层身份归一，声明了 cli binding 时
  // 系统推送会落进 principal 会话（与你在钉钉私聊里的上下文同一条），而不是孤立的 cli:local。
  return {
    channel: "cli",
    chatId: resolvePrivateChatId("cli", "local", CLI_DEFAULT_CHAT_ID),
    chatType: "private",
    ownerSenderId: "local",
  };
}

/** 活跃会话的回复通道注册表：chatId → reply（收到新消息时刷新） */
const activeReply = new Map<string, ReplyFn>();

export function setActiveReply(chatId: string, reply: ReplyFn): void {
  activeReply.set(chatId, reply);
}

export function getActiveReply(chatId: string): ReplyFn | undefined {
  return activeReply.get(chatId);
}

/**
 * 渠道主动推送：不依赖任何会话上下文，可在任意时刻送达。
 *
 * 导出给 HTTP 层复用——后台/CLI 在一个**钉钉**会话里发言时，boss 的回复除了回给
 * 当次请求，还要真的推到那个钉钉群里，否则群里的人只看得见提问看不见回答。
 */
export async function pushToChannel(
  target: DeliveryTarget,
  text: string,
  card?: OutboundCard,
): Promise<boolean> {
  if (target.channel === "cli") {
    // CLI / web 没有按钮概念，直接用 text（本来就含完整选项清单）
    pushBossMessage(target.chatId, text);
    return true;
  }
  // 动态 import：静态引入会与 registry → dingtalk/channel → manager → boss → delivery 成环。
  // 调用时机远在模块加载完成之后，ESM 会直接命中已解析的模块表。
  const { getChannel } = await import("../channels/registry.js");
  const channel = getChannel(target.channel);
  if (!channel?.push) return false;
  return channel.push(target, text, card);
}

/**
 * 投递一条消息，永不抛出。
 * 活跃会话优先（即时、带上下文）；失败或不存在则走主动推送；都不成只落日志。
 * card 是渐进增强：支持的渠道渲染成可点按钮，其余渠道忽略——text 必须自带完整语义。
 */
export async function deliver(
  target: DeliveryTarget,
  text: string,
  card?: OutboundCard,
): Promise<void> {
  const record = {
    time: new Date().toISOString(),
    direction: "out" as const,
    channel: target.channel,
    chatType: target.chatType,
    chatId: target.chatId,
    text,
    // 按钮只存标题：事后排查「当时给了哪些选项」够用，不必存 dtmd URL
    ...(card ? { card: describeActions(card) } : {}),
  };

  // 后台对话页按 chat 订阅 boss-push，要当钉钉会话的镜像用，所以非 cli 渠道的出站消息
  // 都补推一份——否则群里其他人触发的对话、几小时后的任务播报，后台永远看不见。
  // cli 渠道不镜像：它的正常投递本身就是 pushBossMessage，会重复。
  if (target.channel !== "cli") pushBossMessage(target.chatId, text);

  const reply = activeReply.get(target.chatId);
  if (reply) {
    try {
      await reply(text, card);
      return; // reply 内部（manager.loggedReply）已记账
    } catch (error) {
      console.warn("[delivery] 活跃会话投递失败，转主动推送:", error);
      activeReply.delete(target.chatId); // 失效通道不再复用
    }
  }

  try {
    if (await pushToChannel(target, text, card)) {
      appendMessageLog(record);
      return;
    }
    console.warn(
      `[delivery] 渠道 ${target.channel} 无可用推送通道，消息仅落日志（chat=${target.chatId}）`,
    );
    appendMessageLog({ ...record, error: "无可用投递通道，仅落日志" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[delivery] 主动推送失败:", message);
    appendMessageLog({ ...record, error: message });
  }
}
