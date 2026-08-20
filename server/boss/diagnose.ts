import { bossThink } from "./think.js";

/**
 * 失败诊断：**每个执行失败都让主管看一眼**，由他决定重试还是收手，并给用户一句人话解释。
 *
 * 为什么要有这一步：此前失败是纯代码路径——关键词命中就重试，命中不了就把网关原文
 * 截断后贴给用户。于是用户收到的是 `[500] {"message":"...aws-marketplace:Subscribe..."}`
 * 这种东西，而「这错误到底能不能重试」由一张关键词表决定，表上没有的新错误一律判死。
 *
 * 为什么是一次 LLM 而不是继续堆签名表：错误文本来自模型网关、runtime、MCP、各家 SDK，
 * 形态无穷且会随上游变；而「这段话是不是在说临时故障」恰恰是语言模型判得比正则准的事。
 * 签名表只保留为**兜底**（见 boss.ts 的 looksTransient）——诊断本身也要过网关，
 * 网关正挂着的时候这一跳同样会失败，那时必须还有个不依赖模型的判断。
 */

export interface FailureDiagnosis {
  action: "retry" | "give_up";
  /** retry 时建议等多久再试（秒）；调用方会夹到合理区间 */
  delaySeconds?: number;
  /** 给用户看的一句话原因（人话，不含 JSON / 栈 / 厂商术语） */
  reason: string;
  /** 一句可执行建议；没有则空 */
  advice?: string;
}

export interface DiagnoseInput {
  errorText: string;
  /** 员工的拟人化展示名（用于把话说得像同事在汇报） */
  displayName: string;
  taskRef: string;
  brief: string;
  chatId: string;
  taskId: string;
  agentName: string;
  errorSource?: "model_gateway" | "runtime";
  statusCode?: number;
  /** 已经自动重试过几次 */
  attempts: number;
  /** 还剩几次预算（0 = 只能收手） */
  remaining: number;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 跑一次诊断。**任何异常都抛出**——调用方据此回落到关键词兜底，
 * 而不是在这里悄悄返回一个「看起来像判断」的默认值（那会把网关故障伪装成「不可重试」）。
 */
export async function diagnoseFailure(input: DiagnoseInput): Promise<FailureDiagnosis> {
  const prompt = [
    "你是团队主管，一个员工执行任务时出错了。你的任务：判断该不该自动重试，并把原因翻译成一句用户能懂的话。",
    "",
    `员工：${input.displayName}（${input.agentName}）｜任务：${input.taskRef}`,
    `任务简报（截断）：${clip(input.brief, 300)}`,
    `错误来源：${input.errorSource === "model_gateway" ? "模型网关" : input.errorSource === "runtime" ? "运行时" : "未知"}${input.statusCode ? `（HTTP ${input.statusCode}）` : ""}`,
    `已自动重试 ${input.attempts} 次，还剩 ${input.remaining} 次预算。`,
    "",
    "错误原文：",
    clip(input.errorText, 2000),
    "",
    "## 怎么判",
    "- **retry**：错误来自临时故障——限流、超时、网关 5xx、上游路由到了坏节点、并发抢占、模型偶发空输出。",
    "  · 判据是「同样的请求过一会儿可能就成了」。原文里出现「稍后重试 / try again / temporarily」这类字样是强信号。",
    "  · 上游是多节点网关时，同一模型可能只有部分节点不可用（如某节点缺模型订阅 / 缺授权）——这类**值得重试**，换个节点就好了。",
    "- **give_up**：重试一万次也一样——凭据无效或过期、模型名不存在、参数/配置错误、权限不足、输入超长、余额耗尽、目标资源不存在。",
    "- 剩余预算为 0 时只能 give_up（但 reason 仍要写清原因）。",
    "- delaySeconds：限流类给 30~120；网关 5xx / 节点问题给 60~300（原文说「5 分钟后再试」就照它说的给）；一般偶发给 5~20。",
    "",
    "## reason 怎么写（这句会直接发给用户）",
    "- **一句话、说人话、说到根因**：用户不关心 JSON 与厂商术语，关心「谁的问题、要不要我做点什么」。",
    "- **不许照抄原文**，也不许写成「发生了一个错误」这种空话。",
    "- 分清责任：是模型服务方的问题就说清「不是你的配置问题」；是本地配置/凭据问题就直说要改哪里。",
    "- advice：一句可执行的下一步（如「等几分钟我再试一次」「去管理后台换 token」「把范围缩小再派」）；确实没有就留空字符串。",
    "",
    "## 输出（只输出 JSON，不要任何解释文字）",
    '{"action":"retry","delaySeconds":120,"reason":"…","advice":"…"}',
    '或 {"action":"give_up","reason":"…","advice":"…"}',
  ].join("\n");

  const { text } = await bossThink({
    kind: "diagnose",
    summary: `诊断「${input.displayName}」这轮失败该不该重试`,
    prompt,
    chatId: input.chatId,
    taskId: input.taskId,
    agentName: input.agentName,
  });

  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`诊断输出里没有 JSON：${clip(text, 200)}`);
  const parsed = JSON.parse(json) as Partial<FailureDiagnosis>;
  if (parsed.action !== "retry" && parsed.action !== "give_up") {
    throw new Error(`诊断给出的 action 非法：${String(parsed.action)}`);
  }
  const reason = parsed.reason?.trim();
  if (!reason) throw new Error("诊断没给 reason");
  return {
    action: parsed.action,
    ...(typeof parsed.delaySeconds === "number" ? { delaySeconds: parsed.delaySeconds } : {}),
    reason,
    ...(parsed.advice?.trim() ? { advice: parsed.advice.trim() } : {}),
  };
}

/**
 * 构造失败诊断上下文（供 emitSystemEvent 和 trigger-frame 使用）。
 */
export function buildDiagnoseContext(task: {
  id: string;
  agentName: string;
  prompt: string;
  brief?: string;
  errorRetries?: number;
}, errorText: string, opts?: {
  errorSource?: string;
  statusCode?: number;
  maxRetries?: number;
}): Record<string, unknown> {
  const used = task.errorRetries ?? 0;
  const maxRetries = opts?.maxRetries ?? 3;
  return {
    errorText,
    agentDisplay: task.agentName,
    retries: used,
    remaining: Math.max(maxRetries - used, 0),
    ...(opts?.errorSource ? { errorSource: opts.errorSource } : {}),
    ...(opts?.statusCode ? { statusCode: opts.statusCode } : {}),
  };
}
