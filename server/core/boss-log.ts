import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { LOG_DIR } from "./logger.js";

/**
 * 主管决策日志。
 *
 * 为什么需要它：员工的每一步都进了 traces（看板能逐条回看），但**主管自己的判断
 * 全程没有留痕**——派给谁、派工简报怎么写的、代答依据是什么、验收凭什么判过或
 * 打回、改派的理由——这些都是裸 `query()` 单轮调用，跑完就丢。结果是任务出问题时
 * 只能看到「员工做了什么」，看不到「主管为什么让他这么做」，责任切分无从下手。
 *
 * 记录的是**决策**，不是提示词全文：prompt 只留尾部（前面是固定模板，留着是噪声），
 * output 尽量完整——判断依据都在里头。
 */
export interface BossDecisionRecord {
  time: string;
  /**
   * 决策类型：
   * - intent：主管本轮对话决策（会话式 agent：自己答 / 派活 / 转达，含实际调用的工具）
   * - assist：主管自主协调（代答 / 改派 / 上抛的裁决）
   * - review：验收裁决（员工没提问也没交卷时判本轮算不算完成）
   * - handoff：串行交接裁决（前置干完后，决定后继照原样派 / 改简报 / 挂起问用户 / 取消）。
   *   与 review 分开记：验收判的是「上一个干成没」，交接判的是「下一个还照原计划做吗」。
   * - feedback：用户反馈识别（旁路廉价分类器，不参与对话）
   * - route：兜底路由（派活未指定员工时按 routeHint 选人）
   * - diagnose：失败诊断（员工这轮报错该不该自动重试 + 给用户的人话解释）
   */
  kind: "intent" | "assist" | "review" | "handoff" | "feedback" | "route" | "diagnose";
  /** 一句话说明这次判断在解决什么，直接显示在看板上 */
  summary: string;
  chatId?: string;
  /** 归属任务；对话决策/路由发生在任务创建之前，此时为空，只有 chatId */
  taskId?: string;
  agentName?: string;
  model: string;
  durationMs: number;
  isError?: boolean;
  /** 入参尾部（前缀是固定模板，截掉不影响判读） */
  promptTail: string;
  /** 模型原始输出（决策依据在这里，尽量留全） */
  output: string;
}

const PROMPT_TAIL_CHARS = 1500;
const OUTPUT_CHARS = 6000;

export function bossLogFile(date: string): string {
  return `${LOG_DIR}boss-${date}.jsonl`;
}

function tail(text: string, n: number): string {
  return text.length > n ? `…${text.slice(-n)}` : text;
}

function head(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/** 追加一条主管决策，写失败仅告警（绝不影响主流程） */
export function appendBossDecision(
  record: Omit<BossDecisionRecord, "promptTail" | "output"> & {
    prompt: string;
    output: string;
  },
): BossDecisionRecord {
  const entry: BossDecisionRecord = {
    time: record.time,
    kind: record.kind,
    summary: record.summary,
    ...(record.chatId ? { chatId: record.chatId } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.agentName ? { agentName: record.agentName } : {}),
    model: record.model,
    durationMs: record.durationMs,
    ...(record.isError ? { isError: true } : {}),
    promptTail: tail(record.prompt, PROMPT_TAIL_CHARS),
    output: head(record.output, OUTPUT_CHARS),
  };
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(bossLogFile(entry.time.slice(0, 10)), `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.warn("[boss-log] 写决策日志失败:", error);
  }
  return entry;
}

/**
 * 某天有过主管决策的会话（chatId → 当天决策条数，按条数倒序）。
 *
 * 主管复盘的目标清单：当天没做过任何判断的会话不必开 session 复盘。
 * 刻意不复用 readBossDecisions —— 那个带 limit 截断（只给看板回放最近 N 条），
 * 用它统计会漏掉当天早些时候的会话。
 */
export function bossChatsOn(date: string): Array<{ chatId: string; decisions: number }> {
  const file = bossLogFile(date);
  if (!existsSync(file)) return [];
  const counts = new Map<string, number>();
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as BossDecisionRecord;
      if (!rec.chatId) continue;
      counts.set(rec.chatId, (counts.get(rec.chatId) ?? 0) + 1);
    } catch {
      // 半行/脏行跳过：日志边写边读，尾行可能不完整
    }
  }
  return [...counts.entries()]
    .map(([chatId, decisions]) => ({ chatId, decisions }))
    .sort((a, b) => b.decisions - a.decisions);
}

/**
 * 回读决策记录（看板历史回放用）。
 * 只扫最近 days 天的文件——决策日志按天分片，跨天任务靠多读一两天覆盖。
 */
export function readBossDecisions(
  filter: { chatId?: string; taskId?: string; limit?: number; days?: number } = {},
): BossDecisionRecord[] {
  const days = filter.days ?? 2;
  const out: BossDecisionRecord[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const file = bossLogFile(date);
    if (!existsSync(file)) continue;
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as BossDecisionRecord;
        if (filter.taskId && rec.taskId !== filter.taskId) continue;
        if (filter.chatId && rec.chatId !== filter.chatId) continue;
        out.push(rec);
      } catch {
        // 半行/脏行跳过：日志是边写边读的，尾行可能不完整
      }
    }
  }
  const limit = filter.limit ?? 200;
  return out.length > limit ? out.slice(-limit) : out;
}
