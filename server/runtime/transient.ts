/**
 * 瞬态错误判据：**两个 runtime 与 boss 主干共用一份**。
 *
 * 为什么必须共用：判据一漂，重试行为就分叉——线上事故 task 2a1839 里编队三步
 * 全以 `terminated`（undici 在流式连接被对端掐断时抛的 TypeError）收场却零重试，
 * 正是因为当时的关键词表里没有它。新增 runtime 时如果各写一份，这个坑会重现。
 */

/** 判定为「值得自动重试」的错误文本特征（全小写匹配） */
export const TRANSIENT_ERROR_MARKERS: readonly string[] = [
  "too many requests",
  "rate limit",
  "限流",
  "频繁",
  "稍后",
  "下一个周期",
  "temporarily",
  "overloaded",
  "timeout",
  "econnrefused",
  "fetch failed",
  // 流式连接被对端中途掐断：undici 抛 `TypeError: terminated`，无状态码。
  // 长连接（多工具循环 + 慢 Bash）常被网关 idle 超时切断，重试（resume）即可续跑。
  "terminated",
  "socket hang up",
  "premature close",
  "econnreset",
  "network error",
];

/** HTTP 状态码本身即可判定为瞬态的集合 */
export const TRANSIENT_STATUS_CODES: readonly number[] = [408, 429, 502, 503, 504];

/** 文本里是否含瞬态特征 */
export function hasTransientMarker(text: string): boolean {
  const haystack = text.toLowerCase();
  return TRANSIENT_ERROR_MARKERS.some((p) => haystack.includes(p));
}

/**
 * 综合判定是否可重试。
 * 500 单独处理：它既可能是「上游真挂了」也可能是稳定的业务错误，只有文本也像瞬态才重试。
 */
export function isRetryableError(text: string, statusCode?: number): boolean {
  const transientText = hasTransientMarker(text);
  if (statusCode && TRANSIENT_STATUS_CODES.includes(statusCode)) return true;
  if (statusCode === 500) return transientText;
  if (!statusCode) return transientText;
  return false;
}
