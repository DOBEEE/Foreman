import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config/index.js";

/**
 * Session 持久化（Vercel AI SDK 路线）。
 * Claude SDK 有 persistSession/resume 内置；AI SDK 需要自己管理 messages 数组。
 * 存储：<runtimeDir>/sessions/<id>.json，24h TTL，与现有行为对齐。
 */

/**
 * 会话消息。content 兼容 AI SDK 的 ResponseMessage——
 * 既可以是纯文本，也可以是结构化 content block 数组（tool-call / tool-result 等）。
 * 不要把 tool call 手工 stringify 成文本：那违反 API 协议，会让 resume 永久失效。
 */
export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
}

/**
 * 剔除空消息。空 content 的 assistant 消息会被 Anthropic API 拒绝，
 * 一旦落盘就会让该 session 之后每次 resume 都返回空（真实事故：session e08d353f）。
 */
export function pruneEmptyMessages(messages: SessionMessage[]): SessionMessage[] {
  return messages.filter((m) => {
    const c = m.content;
    if (c == null) return false;
    if (typeof c === "string") return c.trim().length > 0;
    if (Array.isArray(c)) return c.length > 0;
    return true;
  });
}

/**
 * 剥掉 reasoning（thinking）块，并丢弃剥完变空的消息。
 *
 * **这是会话中毒的根因，实测确认**：reasoning 块带 `providerOptions.anthropic.signature`
 * —— 一个与模型绑定的加密串。把它跨轮回放给网关，会把**不属于本会话的内容注入上下文**。
 * 实测证据（session 50070704，同一份历史、同一个模型、只差有没有 reasoning）：
 *   - 原样重放 → 答「我这儿没有「小美」这个人…你要转告的是哪位？」（全程没出现过「小美」）
 *   - 线上那次 → 答「现在是 2026 年 8 月 6 日 14:19」，而它的 reasoning 里写着
 *     「现在用户问现在几点了」＋一段可疑域名/索要系统提示词的对话，全都没发生过
 *   - 剥掉 reasoning → 「抱歉，上一条我答岔了。我这边翻了任务记录，没有「图片域名替换」这条…」正常
 *
 * 为什么剥了没有副作用：跨轮的对话连续性靠 **text + tool-call**，thinking 不参与；
 * 而它的 signature 一旦与当前模型不匹配（本会话就混了 claude-quince 与 claude-opus-4-8
 * 两个模型的签名），回放行为就是未定义的。
 *
 * 另一个它单独就能治的问题：只含 reasoning 的 assistant 消息（无 text、无 tool-call）
 * 不是合法的对话轮次，而 pruneEmptyMessages 挡不住它（content 是非空数组）。
 */
export function stripReasoningParts(messages: SessionMessage[]): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const kept = (m.content as Array<{ type?: string }>).filter((p) => p?.type !== "reasoning");
    if (kept.length === 0) continue; // 整条只有 thinking → 不是合法轮次，丢弃
    out.push({ ...m, content: kept });
  }
  return out;
}

/** 落盘/回放前的统一清洗：先剥 thinking，再剔空消息 */
export function sanitizeSessionMessages(messages: SessionMessage[]): SessionMessage[] {
  return pruneEmptyMessages(stripReasoningParts(messages));
}

export interface SessionState {
  id: string;
  messages: SessionMessage[];
  activatedSkills: string[];
  tokenEstimate: number;
  createdAt: number;
  lastActiveAt: number;
  /** 最近一轮的持久化进度，供中断恢复与事后归因。 */
  checkpoint?: {
    state: "running" | "interrupted" | "completed";
    completedSteps: number;
    updatedAt: number;
    error?: {
      source: "model_gateway" | "runtime";
      retryable: boolean;
      statusCode?: number;
      message: string;
    };
  };
}

const TTL_MS = 24 * 60 * 60 * 1000;

function sessionsDir(): string {
  return join(config.runtimeDir, "sessions");
}

function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

export function generateSessionId(): string {
  return randomUUID().slice(0, 8);
}

export function saveSession(state: SessionState): void {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  const target = sessionPath(state.id);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // 同目录临时文件 + rename：进程在写到一半时退出，旧存档仍保持完整；
    // rename 在同一文件系统内是原子的，读方不会看到半截 JSON。
    writeFileSync(temp, JSON.stringify(state), "utf-8");
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * 旧格式（已污染）判定：修复前的实现把 tool call/result stringify 成文本存进
 * role:"assistant"/"tool"，还会落一条空 assistant 消息。这种存档违反 API 协议，
 * 每次 resume 都必然返回空且无法修补——只能丢弃重开。
 */
function isCorruptLegacySession(state: SessionState): boolean {
  return state.messages.some((m) => {
    if (typeof m.content !== "string") return false;
    if (!m.content.trim()) return true;
    if (m.role === "tool") return true;
    return m.content.startsWith('{"type":"tool_use"') || m.content.startsWith('{"type":"tool_result"');
  });
}

export function loadSession(id: string): SessionState | undefined {
  const path = sessionPath(id);
  if (!existsSync(path)) return undefined;
  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as SessionState;
    if (Date.now() - state.lastActiveAt > TTL_MS) {
      rmSync(path, { force: true });
      return undefined;
    }
    if (isCorruptLegacySession(state)) {
      console.warn(`[session] ${id} 为旧版损坏格式，丢弃重建（原存档无法用于 resume）`);
      rmSync(path, { force: true });
      return undefined;
    }
    // 已落盘的会话可能带着 reasoning 块（中毒源，见 stripReasoningParts）——
    // 在这里清洗一次，存量会话下次被使用即自愈，不必手工删会话或写一次性迁移
    state.messages = sanitizeSessionMessages(state.messages);
    return state;
  } catch {
    return undefined;
  }
}

export function deleteSession(id: string): void {
  rmSync(sessionPath(id), { force: true });
}

/**
 * Token 估算。
 * 不能用统一的「4 字符 = 1 token」——那是英文的比例，中文约 1.7 字/token，
 * 一刀切会把中文用量低估 2.3 倍，导致压缩阈值形同虚设（长会话该压不压，
 * 一路涨到撞模型窗口才报错）。这里按 CJK / 非 CJK 分别加权。
 */
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

export function estimateTokens(messages: SessionMessage[]): number {
  let total = 0;
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const cjk = text.match(CJK_RE)?.length ?? 0;
    const rest = text.length - cjk;
    total += cjk / 1.7 + rest / 4;
  }
  return Math.ceil(total);
}

/**
 * Context 压缩：token 估算超阈值时把早期消息摘要为一条，保留最近 KEEP_RECENT 条。
 *
 * summarize 传入时用 LLM 做真摘要（质量高得多）；不传或失败则回落到文本拼接。
 * 注意角色约束不靠这里保留——system prompt 是 API 独立参数、每轮完整重发，
 * 压缩不会动它；activatedSkills 原样带过，由上层重注入。
 */
const KEEP_RECENT = 10;

export interface CompactOptions {
  /** 模型上下文窗口（token） */
  windowTokens: number;
  /** 软阈值比例：到这里**且缓存已冷**才压 */
  atPercent: number;
  /** 硬阈值比例：到这里无条件压 */
  hardAtPercent: number;
  /** 本会话 prompt cache 的 TTL（毫秒）。用于判断缓存是否已经凉了 */
  cacheTtlMs: number;
  summarize?: (text: string) => Promise<string>;
}

/**
 * 压缩会**改写上下文前缀**，而 prompt cache 是按字节前缀匹配的——
 * 一压，服务端就认不出来了，下一次必然全量重灌（写入 1.25x/2x，而读取只要 0.1x）。
 * 所以缓存还活着的时候压缩是净亏损：省下的那点上下文远不如重灌的代价。
 *
 * 于是分两级（对齐 openclaw 的 contextPruning.mode="cache-ttl"）：
 * - 软阈值：只有距上次活动已超过 cache TTL（缓存反正凉了、重灌躲不掉）才压，此时压缩是免费的
 * - 硬阈值：无条件压。撞上下文窗口是**硬失败**，优先级高于省钱
 */
function compactDecision(
  state: SessionState,
  opts: CompactOptions,
): { compact: boolean; reason: "hard-threshold" | "cache-expired" | "none" } {
  if (state.tokenEstimate >= opts.windowTokens * opts.hardAtPercent) {
    return { compact: true, reason: "hard-threshold" };
  }
  if (state.tokenEstimate < opts.windowTokens * opts.atPercent) {
    return { compact: false, reason: "none" };
  }
  const cacheCold = Date.now() - state.lastActiveAt > opts.cacheTtlMs;
  return cacheCold
    ? { compact: true, reason: "cache-expired" }
    : { compact: false, reason: "none" };
}

export async function compactIfNeeded(
  state: SessionState,
  opts: CompactOptions,
): Promise<{ state: SessionState; compacted: boolean; reason: string }> {
  const decision = compactDecision(state, opts);
  if (!decision.compact) return { state, compacted: false, reason: decision.reason };
  if (state.messages.length <= KEEP_RECENT) {
    return { state, compacted: false, reason: "too-few-messages" };
  }

  // 切分点前移到第一条非 tool 消息：tool 结果若与它配对的 tool call 被摘要掉，
  // 剩下的孤儿 tool 消息违反 API 协议，会让整个请求失败
  let cut = state.messages.length - KEEP_RECENT;
  while (cut < state.messages.length && state.messages[cut].role === "tool") cut++;

  const toSummarize = state.messages.slice(0, cut);
  const recent = state.messages.slice(cut);

  const transcript = toSummarize
    .map((m) => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${m.role}] ${text.slice(0, 800)}`;
    })
    .join("\n");

  let summary = "";
  if (opts.summarize) {
    try {
      summary = (await opts.summarize(transcript)).trim();
    } catch (error) {
      console.warn("[session] LLM 摘要失败，回落文本拼接:", error);
    }
  }
  if (!summary) {
    const parts: string[] = [];
    for (const m of toSummarize) {
      if (m.role === "assistant" && typeof m.content === "string") {
        parts.push(m.content.slice(0, 500));
      }
    }
    summary = parts.join("\n---\n").slice(0, 3000) || "[earlier context omitted]";
  }

  const compactedMessages: SessionMessage[] = [
    { role: "user", content: `[此前对话摘要]\n${summary}` },
    ...recent,
  ];

  return {
    state: {
      ...state,
      messages: compactedMessages,
      tokenEstimate: estimateTokens(compactedMessages),
      lastActiveAt: Date.now(),
    },
    compacted: true,
    reason: decision.reason,
  };
}

/** 清理过期 session 文件（可在 startup 或定时调用） */
export function cleanupExpiredSessions(): number {
  const dir = sessionsDir();
  if (!existsSync(dir)) return 0;
  let cleaned = 0;
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const path = join(dir, file);
      try {
        const raw = readFileSync(path, "utf-8");
        const state = JSON.parse(raw) as { lastActiveAt?: number };
        if (state.lastActiveAt && Date.now() - state.lastActiveAt > TTL_MS) {
          rmSync(path, { force: true });
          cleaned++;
        }
      } catch {
        rmSync(path, { force: true });
        cleaned++;
      }
    }
  } catch {
    /* dir read failed, skip */
  }
  return cleaned;
}
