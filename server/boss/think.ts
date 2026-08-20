import { config } from "../config/index.js";
import { resolveProvider } from "../config/provider-env.js";
import { getRuntime } from "../runtime/index.js";
import { appendBossDecision, type BossDecisionRecord } from "../core/boss-log.js";
import { publishBossDecision } from "./event-bus.js";

/**
 * 主管的单轮 LLM 调用统一入口。
 *
 * 分诊 / 代答裁决 / 验收 / 直答 / 兜底路由本来各写一份一模一样的调用，
 * 且**都不留痕**。收敛到这里的唯一目的是：主管的每次判断都落一条决策记录
 * （日志 + 事件总线），让看板能像看员工 trace 一样看主管的思路。
 *
 * 语义与原先逐份实现保持一致：单轮、无工具、不继承用户级配置。
 * 调用方仍自己解析文本 —— 这里只负责「跑 + 留痕」，不碰任何判定逻辑。
 */
export interface BossThinkInput {
  kind: BossDecisionRecord["kind"];
  /** 一句话说明这次判断要解决什么（直接显示在看板上） */
  summary: string;
  prompt: string;
  chatId?: string;
  taskId?: string;
  agentName?: string;
  /** 直答场景：延续主管与该会话的连续对话 */
  resume?: string;
  persistSession?: boolean;
}

export interface BossThinkResult {
  text: string;
  sessionId?: string;
  isError: boolean;
}

export async function bossThink(input: BossThinkInput): Promise<BossThinkResult> {
  const prov = resolveProvider({ id: config.boss.providerId, model: config.boss.model });
  const model =
    config.boss.model ?? config.routerModel ?? prov.providerDefaultModel ?? config.model;
  const startedAt = Date.now();
  let text = "";
  let sessionId: string | undefined;
  let isError = false;
  try {
    const result = await getRuntime().complete({
      prompt: input.prompt,
      model,
      cwd: config.workingDir,
      env: prov.env as Record<string, string>,
      ...(input.persistSession ? { persistSession: true } : {}),
      ...(input.resume ? { resume: input.resume } : {}),
    });
    text = result.text;
    sessionId = result.sessionId;
    isError = result.isError;
  } catch (error) {
    isError = true;
    text = error instanceof Error ? error.message : String(error);
    record(input, model, startedAt, text, true);
    throw error;
  }
  record(input, model, startedAt, text, isError);
  return { text, ...(sessionId ? { sessionId } : {}), isError };
}

function record(
  input: BossThinkInput,
  model: string | undefined,
  startedAt: number,
  output: string,
  isError: boolean,
): void {
  const entry = appendBossDecision({
    time: new Date(startedAt).toISOString(),
    kind: input.kind,
    summary: input.summary,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    model: model ?? "(SDK 默认)",
    durationMs: Date.now() - startedAt,
    ...(isError ? { isError: true } : {}),
    prompt: input.prompt,
    output,
  });
  publishBossDecision(entry);
}
