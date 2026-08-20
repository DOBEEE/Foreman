import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import type { RuntimeKind } from "../runtime/types.js";

/**
 * Boss 运行时记忆（隐私数据，存 <runtimeDir>/boss，**不进 git**）。
 * 两层作用域：
 * - 公共记忆 chat/<chatId>.md：会话级，该 chat 所有人共享（悬念、任务模式、群约定）
 * - 个人记忆 user/<senderId>.md：跟人跨 chat（称呼、通用偏好）
 * 与 employee memory（团队知识资产、进 git）严格区分。
 */
const bossDir = join(config.runtimeDir, "boss");
const memoryDir = join(bossDir, "memory");
const sessionsFile = join(bossDir, "boss-sessions.json");

function safe(id: string): string {
  return id.replace(/[^\w-]/g, "_");
}

function chatMemoryFile(chatId: string): string {
  return join(memoryDir, "chat", `${safe(chatId)}.md`);
}
function userMemoryFile(senderId: string): string {
  return join(memoryDir, "user", `${safe(senderId)}.md`);
}

function readIfExists(file: string, maxChars: number): string | undefined {
  try {
    const t = readFileSync(file, "utf-8").trim();
    if (!t) return undefined;
    return t.length > maxChars ? `${t.slice(0, maxChars)}\n…（超出预算已截断）` : t;
  } catch {
    return undefined;
  }
}

/**
 * 单层记忆注入预算（字符）。复盘写入时也按它控制体量——
 * 写超了不会报错，只会在注入时被静默截断，等于白写。
 */
export const BOSS_MEMORY_BUDGET = 2500;

/**
 * 组装注入 boss 上下文的记忆块：个人记忆 + 公共记忆。
 * 个人记忆带「只影响行为、群里不主动复述」的约束标注。
 */
export function loadBossMemory(
  chatId: string,
  senderId: string,
  budget = BOSS_MEMORY_BUDGET,
): string | undefined {
  const personal = readIfExists(userMemoryFile(senderId), budget);
  const shared = readIfExists(chatMemoryFile(chatId), budget);
  if (!personal && !shared) return undefined;
  const parts: string[] = [];
  if (personal) {
    parts.push(
      `### 关于当前对话者的个人记忆（仅用于调整你的回应方式，**不要在群里主动复述这些内容**）\n${personal}`,
    );
  }
  if (shared) {
    parts.push(`### 本会话的公共记忆（悬念/约定/历史）\n${shared}`);
  }
  return parts.join("\n\n");
}

/** 供复盘/蒸馏写入（增量由写入方保证）；path 暴露给写入侧 */
export function chatMemoryPath(chatId: string): string {
  mkdirSync(join(memoryDir, "chat"), { recursive: true });
  return chatMemoryFile(chatId);
}
export function userMemoryPath(senderId: string): string {
  mkdirSync(join(memoryDir, "user"), { recursive: true });
  return userMemoryFile(senderId);
}

/** 两层记忆的目录（顺带建好）：复盘要在提示词里告诉模型往哪写、现有哪些文件 */
export function bossMemoryDirs(): { chatDir: string; userDir: string } {
  const chatDir = join(memoryDir, "chat");
  const userDir = join(memoryDir, "user");
  mkdirSync(chatDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  return { chatDir, userDir };
}

/* ── boss 对话会话（连续性，重启不丢） ── */

/** 会话记录带人格指纹：boss.json 改了（改名/改性格）→ 指纹变 → 旧会话作废，避免历史里的旧人格继续生效 */
interface SessionRecord {
  id: string;
  persona?: string;
  /** 产出这个 id 的 runtime。缺失=切 runtime 之前的老记录，按异源处理 */
  runtime?: RuntimeKind;
}

function loadSessions(): Record<string, SessionRecord> {
  try {
    const raw = JSON.parse(readFileSync(sessionsFile, "utf-8")) as Record<
      string,
      string | SessionRecord
    >;
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? { id: v } : v]),
    );
  } catch {
    return {};
  }
}

/**
 * 取上次的主管会话，用于 resume 续接对话。
 *
 * 两条作废判据，任一不符就当没有会话（开新的）：
 * - **persona 变了**：换了人格等于换了个主管，不该继承上一个人的上下文；
 * - **runtime 变了**：sessionId 是 runtime 私有的——Vercel 的存在 `<runtimeDir>/sessions/`，
 *   Qoder 的存在 `~/.qoder/projects/<项目>/`。把 A 的 id 递给 B 会**致命失败**
 *   （实测 Qoder worker 直接 exit 42：`Invalid session identifier`），且因为脏 id
 *   一直留在这里，每一轮对话都会重复失败。
 */
export function getBossSession(chatId: string, personaKey: string): string | undefined {
  const rec = loadSessions()[chatId];
  if (!rec || rec.persona !== personaKey) return undefined;
  // 历史记录没有 runtime 字段：那是切 runtime 之前写的，一律视为异源，不复用
  if (rec.runtime !== config.runtimeKind) return undefined;
  return rec.id;
}

export function setBossSession(chatId: string, sessionId: string, personaKey: string): void {
  try {
    mkdirSync(bossDir, { recursive: true });
    const all = loadSessions();
    all[chatId] = { id: sessionId, persona: personaKey, runtime: config.runtimeKind };
    writeFileSync(sessionsFile, JSON.stringify(all));
  } catch {
    // 记录失败不阻塞
  }
}
