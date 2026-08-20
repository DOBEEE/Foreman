/**
 * 钉钉企业内部机器人「主动推送」：
 * 复用 Stream 模式同一套凭证（DINGTALK_CLIENT_ID/SECRET，即 AppKey/AppSecret），
 * 无需群里配置自定义 webhook 机器人。
 *
 * API（新版 api.dingtalk.com）：
 * - 取企业应用 token：POST /v1.0/oauth2/accessToken { appKey, appSecret } → { accessToken, expireIn }
 * - 群聊推送：POST /v1.0/robot/groupMessages/send { robotCode, openConversationId, msgKey, msgParam }
 * - 单聊批量推送：POST /v1.0/robot/oToMessages/batchSend { robotCode, userIds, msgKey, msgParam }
 * openConversationId = 群消息里带的 conversationId（我们的群 chatId 存的就是它）。
 *
 * 凭据显式传入而非在此读全局配置：token 缓存按 clientId 分键，用户在后台换了 AppKey 之后
 * 不会再拿旧 token 继续推到 2 小时过期为止。
 */

import { processLocalImages } from "./media.js";
import { previewTitle, toDingTalkMarkdown } from "./markdown.js";
import { dtmdReplyUrl, type OutboundCard } from "../card.js";
import { resolveDingTalkCreds, type DingTalkCreds } from "./creds.js";
import type { DeliveryTarget } from "../types.js";

const API = "https://api.dingtalk.com";

/** clientId → accessToken（按 AppKey 分键：换了凭据即自然弃用旧 token） */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(c: DingTalkCreds): Promise<string> {
  const cached = tokenCache.get(c.clientId);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const res = await fetch(`${API}/v1.0/oauth2/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey: c.clientId, appSecret: c.clientSecret }),
  });
  const body = (await res.json()) as { accessToken?: string; expireIn?: number };
  if (!res.ok || !body.accessToken) {
    throw new Error(`获取钉钉 accessToken 失败: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  tokenCache.set(c.clientId, {
    token: body.accessToken,
    expiresAt: Date.now() + (body.expireIn ?? 7200) * 1000,
  });
  return body.accessToken;
}

async function robotSend(
  c: DingTalkCreds,
  path: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const token = await getAccessToken(c);
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`钉钉推送失败 ${res.status}: ${text.slice(0, 300)}`);
  }
}

/** 主动推送 markdown 到群（openConversationId = 群消息的 conversationId） */
export async function pushGroupMarkdown(
  c: DingTalkCreds,
  openConversationId: string,
  text: string,
): Promise<void> {
  await robotSend(c, "/v1.0/robot/groupMessages/send", {
    robotCode: c.robotCode,
    openConversationId,
    msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({
      title: previewTitle(text),
      text: toDingTalkMarkdown(await processLocalImages(c, text)),
    }),
  });
}

/** 主动推送 markdown 单聊（userIds = staffId 列表） */
export async function pushUserMarkdown(
  c: DingTalkCreds,
  userIds: string[],
  text: string,
): Promise<void> {
  await robotSend(c, "/v1.0/robot/oToMessages/batchSend", {
    robotCode: c.robotCode,
    userIds,
    msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({
      title: previewTitle(text),
      text: toDingTalkMarkdown(await processLocalImages(c, text)),
    }),
  });
}

/**
 * 把卡片编成 ActionCard 的 msgKey + msgParam。
 * 钉钉给每种按钮数量配了**不同的 msgKey**（不是同一个 key 传按钮数组）：
 * 1 个按钮用 sampleActionCard（singleTitle/singleURL），2~5 个用 sampleActionCard2..5
 * （actionTitle1..N / actionURL1..N）。按钮数上限 5 由 makeCard 保证。
 * 用的是官方样例模板，**无需在卡片平台建模板、无需 templateId**。
 */
async function encodeActionCard(
  c: DingTalkCreds,
  card: OutboundCard,
): Promise<{ msgKey: string; msgParam: string }> {
  const text = toDingTalkMarkdown(await processLocalImages(c, card.text));
  if (card.actions.length === 1) {
    return {
      msgKey: "sampleActionCard",
      msgParam: JSON.stringify({
        title: card.title,
        text,
        singleTitle: card.actions[0].title,
        singleURL: dtmdReplyUrl(card.actions[0].reply),
      }),
    };
  }
  const param: Record<string, string> = { title: card.title, text };
  card.actions.forEach((a, i) => {
    param[`actionTitle${i + 1}`] = a.title;
    param[`actionURL${i + 1}`] = dtmdReplyUrl(a.reply);
  });
  return {
    msgKey: `sampleActionCard${card.actions.length}`,
    msgParam: JSON.stringify(param),
  };
}

/** 主动推送可点按钮卡片到群 */
export async function pushGroupCard(
  c: DingTalkCreds,
  openConversationId: string,
  card: OutboundCard,
): Promise<void> {
  await robotSend(c, "/v1.0/robot/groupMessages/send", {
    robotCode: c.robotCode,
    openConversationId,
    ...(await encodeActionCard(c, card)),
  });
}

/** 主动推送可点按钮卡片到单聊 */
export async function pushUserCard(
  c: DingTalkCreds,
  userIds: string[],
  card: OutboundCard,
): Promise<void> {
  await robotSend(c, "/v1.0/robot/oToMessages/batchSend", {
    robotCode: c.robotCode,
    userIds,
    ...(await encodeActionCard(c, card)),
  });
}

/**
 * `Channel.push` 的钉钉实现：投递层只给一个目标，群/单聊与卡片/纯文本的分发在这里收口。
 * 缺凭据返回 false，让投递层继续回落（而不是抛错中断整条投递链）。
 */
export async function dingtalkPush(
  target: DeliveryTarget,
  text: string,
  card?: OutboundCard,
): Promise<boolean> {
  const c = resolveDingTalkCreds();
  if (!c) return false;
  const isGroup = target.chatType === "group";
  if (card) {
    if (isGroup) await pushGroupCard(c, target.chatId, card);
    else await pushUserCard(c, [target.ownerSenderId ?? target.chatId], card);
    return true;
  }
  if (isGroup) await pushGroupMarkdown(c, target.chatId, text);
  else await pushUserMarkdown(c, [target.ownerSenderId ?? target.chatId], text);
  return true;
}
