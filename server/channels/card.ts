/**
 * 出站卡片模型（渠道无关）。
 *
 * 定位：**渐进增强**。卡片只负责「让选项可点」，`text` 始终承载完整问题原文——
 * 所以不支持卡片的渠道（CLI / web / 日志 / 推送回落）直接用 text 就是完整体验，
 * 卡片丢了不丢信息。构造方永远要把话说全，别指望按钮把语义补上。
 *
 * 交互实现：按钮 URL 用钉钉 DTMD 协议 `dtmd://dingtalkclient/sendMessage?content=…`，
 * 点一下等于用户把 `reply` 这句话发给机器人，走原有入站管道——
 * 因此不需要卡片平台模板、不需要公网回调、也不需要新的 HTTP 端点。
 */

/** ActionCard 最多 5 个按钮（sampleActionCard5 / btns 上限） */
export const MAX_CARD_ACTIONS = 5;

export interface CardAction {
  /** 按钮文字（钉钉按钮很窄，控制在十来个字内） */
  title: string;
  /** 点击后代用户发出的文本；必须能被入站管道无歧义理解（如带 #任务号） */
  reply: string;
}

export interface OutboundCard {
  title: string;
  /** markdown 正文 */
  text: string;
  actions: CardAction[];
}

/**
 * 组装卡片：按钮超过上限则截断（保留前 N 个）。
 * 截断不补「还有更多」提示——正文 text 里本来就有完整选项清单，用户可以直接打字。
 * actions 为空时返回 undefined：没有可点的东西就不该发卡片，退回普通 markdown。
 */
export function makeCard(
  title: string,
  text: string,
  actions: CardAction[],
): OutboundCard | undefined {
  const usable = actions.filter((a) => a.title.trim() && a.reply.trim());
  if (usable.length === 0) return undefined;
  return { title, text, actions: usable.slice(0, MAX_CARD_ACTIONS) };
}

/** 按钮点击 → 代用户发送该文本。钉钉客户端协议，非 http URL */
export function dtmdReplyUrl(content: string): string {
  return `dtmd://dingtalkclient/sendMessage?content=${encodeURIComponent(content)}`;
}

/** 卡片按钮摘要（落日志用，便于事后核对当时给了哪些选项） */
export function describeActions(card: OutboundCard): string {
  return card.actions.map((a) => a.title).join(" | ");
}
