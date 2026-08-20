import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";

/**
 * memory 根目录：<runtimeDir>/memory/（复盘沉淀的经验库）。
 * 属于「使用中产生的用户数据」，与代码分离、不进 git。
 */
export const MEMORY_ROOT = join(config.runtimeDir, "memory");

/** 某员工经验库目录 */
export function memoryDirOf(agentName: string): string {
  return `${join(MEMORY_ROOT, agentName)}/`;
}

/** 索引文件：只列摘要 + 指向分片，注入首选 */
export function indexFileOf(agentName: string): string {
  return join(MEMORY_ROOT, agentName, "index.md");
}

/** 分片文件（topics/<类别>.md），细节经验全文 */
export function topicFileOf(agentName: string, topic: string): string {
  return join(MEMORY_ROOT, agentName, "topics", `${topic}.md`);
}

/** 某员工当天的 daily 笔记路径（date=YYYY-MM-DD） */
export function dailyFileOf(agentName: string, date: string): string {
  return join(MEMORY_ROOT, agentName, "daily", `${date}.md`);
}

function readIfExists(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const t = readFileSync(file, "utf-8").trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/** 全部分片全文拼接（小库全量注入用） */
function readAllTopics(agentName: string): string {
  const dir = topicFileOf(agentName, "__x").replace(/__x\.md$/, "");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return files
    .map((f) => readIfExists(`${dir}${f}`))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 组装回注进系统提示词的经验内容，分层 + 阈值降级：
 * - 小库（index + 全部分片总字数 ≤ fullBudget）：全量注入，省一次 Read 往返
 * - 大库：只注入 index.md（摘要 + 分片路径），细节让 agent 按需 Read topics/<x>.md
 * 无 index 时回落读旧版 memory.md（平滑兼容）。
 */
export function loadMemory(agentName: string, fullBudget = 4000): string | undefined {
  const index = readIfExists(indexFileOf(agentName));

  // 兼容旧结构：无 index 但有 memory.md
  if (!index) {
    const legacy = readIfExists(join(MEMORY_ROOT, agentName, "memory.md"));
    if (!legacy) return undefined;
    return legacy.length > fullBudget
      ? `${legacy.slice(0, fullBudget)}\n\n…（经验库超出注入预算，其余可用 Read 查阅 ${memoryDirOf(agentName)}memory.md）`
      : legacy;
  }

  const topics = readAllTopics(agentName);
  const full = topics ? `${index}\n\n${topics}` : index;

  if (full.length <= fullBudget) return full; // 小库：连分片一起注入

  // 大库：只给索引 + 明确按需读的指引（含 Grep 全文兜底）
  return [
    index,
    "",
    `（以上为经验索引。需要某类经验细节时，用 Read 打开对应分片：${memoryDirOf(agentName)}topics/<类别>.md；` +
      `若索引未覆盖你要找的内容，用 Grep 在 ${memoryDirOf(agentName)} 全文检索关键词再 Read 命中的分片。）`,
  ].join("\n");
}
