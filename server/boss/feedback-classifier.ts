import { config } from "../config/index.js";
import { resolveProvider } from "../config/provider-env.js";
import { getRuntime } from "../runtime/index.js";
import { appendBossDecision } from "../core/boss-log.js";
import { publishBossDecision } from "./event-bus.js";
import type { Task } from "./types.js";

/**
 * 用户反馈识别：旁路的廉价分类器。
 *
 * 为什么不做成 boss 的工具：反馈是**被动信号**，不面向用户、不影响本轮回复，
 * 做成工具模型一定会忘记调（它眼里这轮已经答完了）。所以独立跑、异步、不阻塞回复。
 *
 * 成本控制：只在**存在最近收尾任务**时才跑——没有已交付的东西，就没有可评价的对象。
 * 用 routerModel（便宜档），不占 boss 的对话上下文。
 */
export interface FeedbackSignal {
  polarity: "positive" | "negative";
  /** 指向哪个任务；判定不明时省略——归错人比没记录更有害 */
  taskId?: string;
  /** 用户表达该反馈的原话（照抄） */
  text: string;
}

export async function classifyFeedback(
  text: string,
  finished: Task[],
  chatId?: string,
): Promise<FeedbackSignal | undefined> {
  if (finished.length === 0) return undefined;

  const brief = finished.map((t) => ({
    taskId: t.id,
    做过: t.prompt.slice(0, 60),
    状态: t.state,
  }));
  const prompt = [
    "判断用户这条消息里是否**明确表达了对已交付工作的满意或不满**。这是给复盘用的外部信号。",
    `最近收尾的任务：\n${JSON.stringify(brief, null, 2)}`,
    "规则：",
    "- 普通提新需求、问问题、给信息、打招呼都**不算**反馈 —— 宁可不输出。",
    "- polarity：positive（认可/道谢/说好了可以了）｜negative（说不对/还是不行/又错了/不是我要的/要返工）",
    "- taskId：这份反馈针对上面哪个任务；**判定不明就省略，不要猜**。",
    "- text：用户表达该反馈的那部分原话，照抄不改写。",
    '输出（只输出 JSON，没有反馈就输出 {}）：{"polarity":"positive|negative","taskId":"<可省略>","text":"..."}',
    `用户消息：${text.trim()}`,
  ].join("\n\n");

  const prov = resolveProvider({ id: config.boss.providerId });
  const model = config.routerModel ?? prov.providerDefaultModel ?? config.model;
  const startedAt = Date.now();
  try {
    const out = await getRuntime().complete({
      prompt,
      model,
      cwd: config.workingDir,
      env: prov.env as Record<string, string>,
    });
    const json = out.text.match(/\{[\s\S]*\}/)?.[0];
    const parsed = json ? (JSON.parse(json) as Partial<FeedbackSignal>) : undefined;
    record(chatId, model, startedAt, prompt, out.text);
    // 结构不完好宁可丢弃：脏数据进复盘输入比没数据更糟
    if (
      (parsed?.polarity === "positive" || parsed?.polarity === "negative") &&
      parsed.text?.trim()
    ) {
      return {
        polarity: parsed.polarity,
        text: parsed.text.trim(),
        ...(parsed.taskId ? { taskId: String(parsed.taskId).replace(/^#/, "") } : {}),
      };
    }
  } catch (error) {
    // 旁路信号，失败不影响主链路：记一笔就算了
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("[boss] 反馈识别失败:", reason);
    record(chatId, model, startedAt, prompt, reason, true);
  }
  return undefined;
}

function record(
  chatId: string | undefined,
  model: string | undefined,
  startedAt: number,
  prompt: string,
  output: string,
  isError = false,
): void {
  const entry = appendBossDecision({
    time: new Date(startedAt).toISOString(),
    kind: "feedback",
    summary: "识别用户反馈",
    ...(chatId ? { chatId } : {}),
    model: model ?? "(默认)",
    durationMs: Date.now() - startedAt,
    ...(isError ? { isError: true } : {}),
    prompt,
    output,
  });
  publishBossDecision(entry);
}
