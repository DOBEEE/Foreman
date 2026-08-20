import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { config } from "../config/index.js";

/**
 * 脑爆话题摘要存储。
 *
 * 为什么不是「追加式聊天记录」：那样只是对话的劣质拷贝，回读还费 token。
 * 这里存的是**每个话题的结构化摘要**，boss 反复调用是在更新固定几个槽位，
 * 而不是一条条往下堆。
 *
 * 为什么不复用现有设施：
 * - `boss-memory`：语义是「对用户的记忆」（语气/偏好），提示词明写「绝不主动向用户复述」
 * - `notes`：按员工分目录 + 14 天 TTL，定位是复盘用的「可丢弃原料」
 * - `workbench`：任务历史索引，形状不对
 *
 * **刻意没有「脑爆结束」概念**：用户可能只是没回、可能换话题、可能两天后接着聊，
 * 任何「结束检测」都是脆的。落盘挂在**内容里程碑**上——讨论产出了值得留的东西
 * 就记一笔，没产出就什么都不写。
 *
 * 最值得留的是**被否掉的方案 + 理由**：它出现在对话早期，而会话压缩
 * （session-store.ts 的 compact）第一个吃掉的就是早期消息。没有它，
 * 同一条死路下周会被重新论证一遍。
 */

// ─── Types ────────────────────────────────────────────────────

/** 一条被否掉的路：方案 + 为什么否 */
export interface RejectedOption {
  option: string;
  reason: string;
}

/**
 * 话题摘要。四个槽位对应「值得留下的东西」的四种形态。
 * 全部可选：脑爆不强制产出结论，可以只有候选、也可以只有待定问题。
 */
export interface TopicDigest {
  chatId: string;
  /** 话题名（boss 自己命名，人类可读，用于索引展示与复述） */
  topic: string;
  /** 稳定 key：由 chatId + topic 归一化后哈希，换名字不影响已存内容 */
  key: string;
  /** 在考虑的方案候选 */
  options: string[];
  /** 已达成的结论 */
  conclusions: string[];
  /** 否掉的路 + 理由（最不该丢的部分） */
  rejected: RejectedOption[];
  /** 悬而未决的问题 */
  openQuestions: string[];
  createdAt: number;
  updatedAt: number;
}

/** 索引行：常驻进 boss 上下文的极简形态 */
export interface TopicIndexEntry {
  topic: string;
  key: string;
  optionCount: number;
  conclusionCount: number;
  rejectedCount: number;
  openCount: number;
  updatedAt: number;
}

/** 索引最多列多少个话题——防止半年后索引本身成为新的膨胀源 */
export const TOPIC_INDEX_LIMIT = 8;

// ─── Paths ────────────────────────────────────────────────────

function thinkingDir(): string {
  const dir = join(config.runtimeDir, "thinking");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 话题 key：chatId + 归一化话题名的哈希。
 *
 * 归一化（去空格/标点、转小写）让「缓存方案」与「缓存方案 」「缓存、方案」收敛到同一条，
 * 否则 boss 每次换个说法就开一条新记录，摘要永远攒不起来。
 */
export function topicKey(chatId: string, topic: string): string {
  const normalized = topic
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。、！？：；「」『』（）()[\]{}"'`~!@#$%^&*_+=|\\/<>,.?:;-]+/g, "");
  return createHash("sha1").update(`${chatId}::${normalized}`).digest("hex").slice(0, 16);
}

function digestPath(key: string): string {
  return join(thinkingDir(), `${key}.json`);
}

// ─── Read ─────────────────────────────────────────────────────

function readDigestByKey(key: string): TopicDigest | undefined {
  const file = digestPath(key);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as TopicDigest;
  } catch {
    return undefined;
  }
}

/** 按话题名取摘要（取不到返回 undefined） */
export function readTopic(chatId: string, topic: string): TopicDigest | undefined {
  return readDigestByKey(topicKey(chatId, topic));
}

/**
 * 本会话的话题索引，按最近更新倒序，最多 TOPIC_INDEX_LIMIT 条。
 * 这是**唯一常驻**进 boss 上下文的部分。
 */
export function listTopicIndex(chatId: string, limit = TOPIC_INDEX_LIMIT): TopicIndexEntry[] {
  const dir = thinkingDir();
  if (!existsSync(dir)) return [];
  const out: TopicIndexEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const d = readDigestByKey(file.slice(0, -".json".length));
    if (!d || d.chatId !== chatId) continue;
    out.push({
      topic: d.topic,
      key: d.key,
      optionCount: d.options.length,
      conclusionCount: d.conclusions.length,
      rejectedCount: d.rejected.length,
      openCount: d.openQuestions.length,
      updatedAt: d.updatedAt,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, limit);
}

// ─── Write ────────────────────────────────────────────────────

/** 单个槽位的增量输入；全部可选，只更新给到的那些 */
export interface CaptureInput {
  options?: string[];
  conclusions?: string[];
  rejected?: RejectedOption[];
  openQuestions?: string[];
}

/** 去重合并：同内容不重复入库（boss 可能把同一条又说一遍） */
function mergeUnique(existing: string[], incoming: string[] | undefined): string[] {
  if (!incoming?.length) return existing;
  const seen = new Set(existing.map((s) => s.trim()));
  const out = [...existing];
  for (const item of incoming) {
    const t = item.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 否掉的路按 option 去重（同一方案被否两次只留一条，理由取最新） */
function mergeRejected(
  existing: RejectedOption[],
  incoming: RejectedOption[] | undefined,
): RejectedOption[] {
  if (!incoming?.length) return existing;
  const byOption = new Map(existing.map((r) => [r.option.trim(), r]));
  for (const r of incoming) {
    const opt = r.option.trim();
    if (!opt) continue;
    byOption.set(opt, { option: opt, reason: r.reason.trim() });
  }
  return [...byOption.values()];
}

/**
 * 更新话题摘要（不存在则创建）。
 *
 * 语义是**更新槽位**而非追加记录——这是它跟「全程速记」的根本区别。
 * 原子写（tmp + rename）：避免半个 JSON 被下游读到。
 */
export function captureTopic(
  chatId: string,
  topic: string,
  input: CaptureInput,
): TopicDigest {
  const key = topicKey(chatId, topic);
  const now = Date.now();
  const prev = readDigestByKey(key);

  const next: TopicDigest = {
    chatId,
    // 话题名取最新的：boss 可能把「缓存」细化成「缓存方案选型」，展示上应跟着走
    topic: topic.trim() || prev?.topic || "未命名话题",
    key,
    options: mergeUnique(prev?.options ?? [], input.options),
    conclusions: mergeUnique(prev?.conclusions ?? [], input.conclusions),
    rejected: mergeRejected(prev?.rejected ?? [], input.rejected),
    openQuestions: mergeUnique(prev?.openQuestions ?? [], input.openQuestions),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };

  const file = digestPath(key);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
  renameSync(tmp, file);
  return next;
}

// ─── Render ───────────────────────────────────────────────────

/** 索引行（常驻）：极简，每话题一行 */
export function renderTopicIndex(entries: TopicIndexEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    const parts: string[] = [];
    if (e.optionCount) parts.push(`${e.optionCount} 候选`);
    if (e.conclusionCount) parts.push(`${e.conclusionCount} 结论`);
    if (e.rejectedCount) parts.push(`${e.rejectedCount} 已否`);
    if (e.openCount) parts.push(`${e.openCount} 待定`);
    return `- 「${e.topic}」（${parts.join(" / ") || "空"}，${ago(e.updatedAt)}）`;
  });
  return lines.join("\n");
}

/** 完整摘要（按需，只在当前正在谈的话题上付这个成本） */
export function renderTopicDigest(d: TopicDigest): string {
  const parts: string[] = [`### 话题「${d.topic}」（${ago(d.updatedAt)}更新）`];
  if (d.options.length) {
    parts.push("**在考虑的方案：**", ...d.options.map((o) => `- ${o}`));
  }
  if (d.conclusions.length) {
    parts.push("**已达成的结论：**", ...d.conclusions.map((c) => `- ${c}`));
  }
  if (d.rejected.length) {
    parts.push(
      "**已否掉的路（不要重新论证）：**",
      ...d.rejected.map((r) => `- ${r.option} —— 因为${r.reason}`),
    );
  }
  if (d.openQuestions.length) {
    parts.push("**悬而未决：**", ...d.openQuestions.map((q) => `- ${q}`));
  }
  return parts.join("\n");
}

/**
 * 显式脑爆信号的轻量预判（纯正则，零成本）。
 *
 * 解决的是一个真实缺口：脑爆模式靠 boss 调 capture_thinking 才开启，
 * 但**第一轮**还没调过任何工具——而第一轮恰恰最需要发散纪律
 * （决定「给一个答案」还是「摆三个方向」就在这一轮）。
 *
 * 只认显式措辞。隐式信号（「你觉得…怎么样」）交给主决策树的 Q1.5 判断，
 * 那种需要语义理解，正则硬猜只会误判。
 *
 * 误判成本是可接受的：多注入一段提示词（花点 token），
 * 而 thinkingModeSection 自带「如果其实是要派活就忽略本段」的保护。
 */
const THINKING_REQUEST_RE =
  /脑爆|头脑风暴|brainstorm|一起想|一起聊|帮我想|帮我梳理|帮我捋|讨论[一下下]|聊[一下下]|碰一下|碰个想法/i;

export function looksLikeThinkingRequest(text: string): boolean {
  return THINKING_REQUEST_RE.test(text);
}

/**
 * 脑爆模式的行为纪律段落。
 *
 * **按需注入，不进主决策树**——boss 的主提示词已经很长，仓库里明确记着
 * 「提示词会被注意力稀释」。发散纪律塞进主树会两头都变差。
 *
 * 这一段是脑爆质量的真正杠杆：LLM 天然收敛太快（给一个答案就完事），
 * 不硬性要求发散，它就退化成「问答」而不是「一起想」。
 */
export function thinkingModeSection(currentDigest?: TopicDigest): string {
  const parts = [
    "## 脑爆纪律（如果你判断这条消息其实是要你派活/要产出物，忽略本段，按派活规则树走）",
    "用户想跟你**一起想**，不是要你派活、也不是要一个标准答案。",
    "",
    "### 发散纪律（这是本模式最重要的部分）",
    "- **先给多个方向再收窄**：至少摆 2-3 个真正不同的思路，不要抓住第一个就往下钻。",
    "- **每个选项都要说代价**。只讲好处等于没讲——用户要判断，判断需要看到取舍。",
    "- **敢质疑前提**。如果这个问题本身问错了（在解决不存在的问题、或真正的瓶颈在别处），直接说出来，这比顺着答有价值得多。",
    "- **不要迎合**。用户的方案有漏洞就指出来，别为了让他舒服而附和。他找你脑爆是要碰撞，不是要捧场。",
    "- **不知道就说不知道**，不要编一个听起来合理的答案。缺什么信息就说缺什么。",
    "- 一次不要抛太多。每轮聚焦一两个点，让讨论能真的往下走。",
    "",
    "### 不要做的事",
    "- **不要偷偷派活**。脑爆期间不调 dispatch_task —— 除非用户明确说「就这么办」「去做吧」。",
    "- **不要急着收口**。没有产出也完全可以，很多想法就是聊完发现不成立，这本身就是收获。",
    "- 不要把讨论包装成结论。还没定的就说还没定。",
    "",
    "### 记录纪律",
    "讨论产出下面任意一种时，**主动调 capture_thinking**（用户不需要提醒你）：",
    "- 摆出了几个方案候选",
    "- 定下了一个结论",
    "- **否掉了某条路 + 理由** ← 这条最重要，不记下来同一条死路下次会被重新论证一遍",
    "- 冒出一个待定问题",
    "",
    "普通来回、你自己的解释**不要记**——记成聊天记录副本反而有害。",
    "记完不用向用户汇报「我记下了」，这是你自己的动作。",
    "",
    "### 什么时候可以转成活",
    "用户明确表态要做了（「就这么办」「你安排吧」），才按正常派活规则树走 dispatch_task，",
    "并且 brief 里带上脑爆得出的结论与约束——那些是这次讨论最值钱的产出，别丢了。",
  ];

  if (currentDigest) {
    parts.push(
      "",
      "### 本话题已经积累的内容（不要重复讨论已否掉的路）",
      renderTopicDigest(currentDigest),
    );
  }

  return parts.join("\n");
}

function ago(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

// ─── 脑爆模式状态 ──────────────────────────────────────────────

/**
 * 当前在脑爆哪个话题（per-chat）。
 *
 * 用途只有一个：决定**哪个话题的完整摘要值得常驻**。正在谈的那个是当前工作面，
 * 付它的 token 是应该的；其余话题只留索引行。
 *
 * **刻意不做「脑爆结束」检测**——那不可实现（用户可能只是没回/换话题/两天后再聊）。
 * 这里用的是 TTL 自然过期：超过静默期就不再算在脑爆中，该话题的全文降回索引。
 * 语义是「当前工作面已经凉了」，而不是「这场脑爆结束了」——摘要仍然留着，随时可捞回。
 */
const MODE_IDLE_TTL_MS = 30 * 60_000; // 30 分钟没动静就降回索引

interface ThinkingMode {
  topic: string;
  lastActiveAt: number;
}

const activeModes = new Map<string, ThinkingMode>();

/** 进入/刷新脑爆模式（boss 调 capture_thinking 或明确开始讨论某话题时） */
export function enterThinkingMode(chatId: string, topic: string): void {
  activeModes.set(chatId, { topic: topic.trim(), lastActiveAt: Date.now() });
}

/** 主动退出（用户说「不聊了」「就这样吧」，或转成派活之后） */
export function exitThinkingMode(chatId: string): void {
  activeModes.delete(chatId);
}

/**
 * 当前正在脑爆的话题；已超静默期则视为不在脑爆（并顺手清理）。
 */
export function activeThinkingTopic(chatId: string, now = Date.now()): string | undefined {
  const mode = activeModes.get(chatId);
  if (!mode) return undefined;
  if (now - mode.lastActiveAt > MODE_IDLE_TTL_MS) {
    activeModes.delete(chatId);
    return undefined;
  }
  return mode.topic;
}

/** 测试用：重置模式状态 */
export function _resetModesForTest(): void {
  activeModes.clear();
}
