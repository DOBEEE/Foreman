import { DEFAULT_AGENT_NAME, getAgent, listRoutableAgents } from "../agents/registry.js";
import {
  isCannotComplete,
  renderTaskReport,
  REPORT_DONE_TOOL,
  type TaskReport,
} from "../tools/task-report.js";
import { appendWorkbench } from "../core/workbench.js";
import { appendTaskArchive } from "../core/task-archive.js";
import { ASK_USER_TOOL } from "../tools/ask-user.js";
import type { BaseAgent } from "../agents/base-agent.js";
import { config } from "../config/index.js";
import { routeAgent, type RouteResult } from "../core/router.js";
import { matchDeterministicIntent, type IntentSegment } from "./intent.js";
import { classifyFeedback } from "./feedback-classifier.js";
import { appendBossBroadcast, runBossAgent } from "./boss-agent.js";
import { Semaphore } from "./concurrency.js";
import { employeeDisplayName, wrapResult } from "./persona.js";
import {
  onTaskTerminal,
  recoverPendingHandoffs,
  setHandoffRuntime,
} from "./handoff.js";
import { missingContractFiles, type Contract } from "../core/contract.js";
import { reviewEmployeeOutput, type ReviewVerdict } from "./review.js";
import { pickDeliveryText } from "./report-style.js";
import { taskManager as tm } from "./task-manager.js";
import { recoverInterruptedTasks } from "./store.js";
import {
  publishAgentEvent,
  publishCreated,
  publishStateChange,
} from "./event-bus.js";
import { deliver, notifyTarget, setActiveReply } from "./delivery.js";
import {
  applyProposal,
  getProposal,
  pendingProposalsBrief,
  pendingProposalsCard,
  rejectProposal,
  revertProposal,
} from "./proposals.js";
import { makeCard, type OutboundCard } from "../channels/card.js";
import { triageCapabilityGap, triageQuestion } from "./assist.js";
import { taskRef } from "./task-label.js";
import { appendFeedback } from "../core/feedback.js";
import {
  approveByRef,
  discardByRef,
  pendingApprovalsBrief,
  resolveApproval,
} from "../bench/approval.js";
import { interruptRun, registerRun, type InflightRun } from "./inflight.js";
import {
  markTurnEnd,
  markTurnStart,
  sweepInterruptedTurns,
} from "./inflight-turn.js";
import { hireTempWorker, reviveTempWorker, touchTempWorker } from "./temp-worker.js";
import { diagnoseFailure, type FailureDiagnosis } from "./diagnose.js";
import { hiredProfileExists } from "../config/agent-profile.js";
import { isHighPrivTool } from "../tools/catalog.js";
import { resumableSessionId, type Task, type TaskState } from "./types.js";
import type { ProgressData } from "../core/runner.js";
import type { ChannelMessage, ReplyFn } from "../channels/types.js";
import { loadSession } from "../runtime/session-store.js";
import { enqueue, setInboxDrainHandler, type InboxEvent, type SystemEventPayload, type InfraEventPayload } from "./inbox.js";
import { classifyEvent, type ChatState } from "./classifier.js";
import { runBossForEvent } from "./boss-agent.js";
import {
  setCrashReporter,
  suppressCrashReporting,
  resumeCrashReporting,
} from "../core/crash-guard.js";

/** 全局并发闸门：整个实例同时执行的 run 数上限 */
const runGate = new Semaphore(config.maxConcurrentRuns);

/** 跨 SDK 内建重试之后的任务级退避；保持同一 task/session，不另建任务。 */
const TRANSIENT_RETRY_DELAYS_MS = [3_000, 8_000, 20_000] as const;

function looksTransient(message: string): boolean {
  const text = message.toLowerCase();
  return [
    "[408]",
    "[429]",
    "[502]",
    "[503]",
    "[504]",
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
    // 流式连接被对端中途掐断（undici `TypeError: terminated` 等）：重试可续跑
    "terminated",
    "socket hang up",
    "premature close",
    "econnreset",
  ].some((part) => text.includes(part));
}


/**
 * 向任务所属会话播报。走统一投递层——活跃会话失效时（进程重启 / webhook 过期，
 * 长任务与定时任务常态）自动回落渠道主动推送，结论不会静默丢失。
 */
function say(task: Task, text: string, card?: OutboundCard): void {
  void deliver(
    {
      channel: task.channel,
      chatId: task.chatId,
      chatType: task.chatType,
      ownerSenderId: task.ownerSenderId,
    },
    text,
    card,
  );
  // 播报记进 boss 会话：用户追问「看下为什么」时所指往往就是刚播报的这条
  appendBossBroadcast(task.chatId, text);
}

/**
 * 由 Task 还原发起时的 ChannelMessage。
 * 员工执行收尾时手上只有 Task，而按消息形态写的操作（如 opHireTempWorker）需要它。
 */
function taskAsMessage(task: Task): ChannelMessage {
  return {
    channel: task.channel,
    chatType: task.chatType,
    chatId: task.chatId,
    senderId: task.ownerSenderId,
    senderName: task.ownerSenderName,
    text: task.prompt,
    raw: { taskId: task.id },
  };
}

/** 群里 @ 发起人，私聊直接称呼 */
function mention(task: Task): string {
  return task.chatType === "group" ? `@${task.ownerSenderName} ` : "";
}

/**
 * 给**带 `####` 标题的**播报拼 @ 发起人。
 * 钉钉 markdown 的标题只在行首生效，`@张三 #### 标题` 会让标题降级成普通文字，
 * 所以 @ 必须单独成行。纯一行短播报仍然用 mention() 内联，读起来更自然。
 */
function withMention(task: Task, body: string): string {
  return task.chatType === "group" ? `@${task.ownerSenderName}\n\n${body}` : body;
}

/**
 * 编队步骤的开工播报。
 *
 * 说话人必须写在最前面：正文来自组长的编队计划，但走的是 boss 的播报通道，
 * 不署名就和主管自己的播报（续跑、中断）长得一模一样，用户读不出「这是队长在动手」。
 *
 * 执行者过 employeeDisplayName：progress 事件里带的是 agent 名（`coder`），
 * 直接显示会与主管派工时说的「小码」对不上，看起来像两个不同的人。
 */
function stepBroadcast(task: Task, p: ProgressData): string {
  const nth = p.index && p.total ? ` · 第 ${p.index}/${p.total} 步` : "";
  const who = p.employee ? ` → ${employeeDisplayName(p.employee)}` : "";
  return `⏳ 「${employeeDisplayName(task.agentName)}」· ${taskRef(task)}${nth}\n${p.title}${who}`;
}

interface AskOption {
  label?: string;
  description?: string;
}
interface AskQuestion {
  question?: string;
  options?: AskOption[];
  multiSelect?: boolean;
}

/**
 * 是否为「向用户提问」的工具调用。
 * 主路径是自建的 ask_user；内置 AskUserQuestion 已对 boss 任务禁用，这里仍然认它——
 * 万一被插件/子 agent 带出来调用了，问题也该照样转给用户，而不是当普通工具忽略掉。
 */
function isAskTool(name: string): boolean {
  return name === ASK_USER_TOOL || name === "AskUserQuestion";
}

/** 从提问工具入参里挑出结构完好的问题（文本渲染与卡片构造共用同一解析） */
function parseAskQuestions(inputs: unknown[]): AskQuestion[] {
  const out: AskQuestion[] = [];
  for (const input of inputs) {
    const questions = (input as { questions?: AskQuestion[] } | undefined)?.questions;
    if (!Array.isArray(questions)) continue;
    for (const q of questions) if (q?.question) out.push(q);
  }
  return out;
}

/**
 * 从提问工具入参提取面向用户的问题文本（含选项）。
 * 员工的过程叙述（勘察/思考）不该转发给用户——用户只关心问题本身。
 * 解析不出结构时返回 undefined，由调用方回落全文。
 */
function formatAskUserQuestion(inputs: unknown[]): string | undefined {
  const blocks = parseAskQuestions(inputs).map((q) => {
    const lines = [q.question!];
    if (Array.isArray(q.options)) {
      q.options.forEach((o, i) => {
        if (o?.label)
          lines.push(`  ${i + 1}. ${o.label}${o.description ? ` —— ${o.description}` : ""}`);
      });
      if (q.multiSelect && q.options.length > 0) lines.push("  （可多选）");
    }
    return lines.join("\n");
  });
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/**
 * 把待确认问题做成可点按钮卡片（答题卡）。
 *
 * 只在**单个问题 + 非多选**时给按钮：多问题时一次点击说不清在答哪个，
 * 多选时一次点击也表达不了组合——这两种情况回落纯文本，用户打字回答。
 * 按钮文本用 `#任务号 选项`，归属绝对无歧义（intent 层有对应的确定性快路径）。
 */
function buildAskCard(task: Task, question: string, inputs: unknown[]): OutboundCard | undefined {
  const questions = parseAskQuestions(inputs);
  if (questions.length !== 1) return undefined;
  const q = questions[0];
  if (q.multiSelect || !Array.isArray(q.options)) return undefined;
  const actions = q.options
    .filter((o): o is AskOption & { label: string } => Boolean(o?.label))
    .map((o) => ({
      // 按钮很窄：标题截断显示，但 reply 用完整 label——答案语义不能因为排版被削掉
      title: o.label.length > 14 ? `${o.label.slice(0, 14)}…` : o.label,
      // 回填必须用纯编号：intent 层的快路径按 `#<id> <内容>` 解析，带上任务名会匹配不到
      reply: `#${task.id} ${o.label}`,
    }));
  return makeCard(
    `${taskRef(task)} 需要你确认`,
    `${question}\n\n（点按钮即可，也可以直接打字说你的想法）`,
    actions,
  );
}

/** 待确认播报的统一版式：标题 + 谁在等 + 问题原文 */
function askBody(task: Task, question: string): string {
  return [
    `#### ❓ 任务 ${taskRef(task)} 需要你确认`,
    `> 「${employeeDisplayName(task.agentName)}」停下来等你一句话`,
    question,
  ].join("\n\n");
}

/**
 * 组装 boss 裁决员工提问所需的上下文：用户原话 + 派工简报 + 本会话历史结论 + 可改派候选。
 * 候选排除已接手过本任务的员工，否则会转回刚失败的那个人。
 */
function assistContext(task: Task): {
  userRequest: string;
  brief?: string;
  history?: string;
  currentAgent: string;
  candidates: BaseAgent[];
  chatId: string;
  taskId: string;
} {
  const tried = new Set(task.triedAgents ?? [task.agentName]);
  tried.add(task.agentName);
  const history = tm
    .recentTasks(task.chatId)
    .filter((t) => t.id !== task.id && t.state === "done" && t.result)
    .slice(0, 3)
    .map((t) => `- #${t.id}（${employeeDisplayName(t.agentName)}）：${truncate(t.result!, 200)}`)
    .join("\n");
  return {
    userRequest: task.prompt,
    ...(task.brief ? { brief: task.brief } : {}),
    ...(history ? { history } : {}),
    currentAgent: task.agentName,
    candidates: listRoutableAgents().filter(
      (a) => !tried.has(a.name) && a.name !== "hr" && a.name !== "retro",
    ),
    chatId: task.chatId,
    taskId: task.id,
  };
}

/** 转人：挂 waiting_user + 播报（带答题卡）。所有升级路径的唯一出口 */
function escalate(
  task: Task,
  question: string,
  sessionId?: string,
  askInputs: unknown[] = [],
): void {
  const prev = task.state;
  tm.markWaiting(task.chatId, task.id, question, sessionId);
  publishStateChange(task, prev);
  say(
    task,
    withMention(task, askBody(task, question)),
    buildAskCard(task, question, askInputs),
  );
}

/**
 * 改派：换人接手并重新派发。
 * 关键：清掉 sessionId——新员工不能继承前一个人的会话上下文（那是别人的思路，
 * 而且 resume 会把他的身份提示词也带进来）。用户原话与简报会重新下发。
 */
function applyReassign(task: Task, toAgent: string, reason: string, handoff: string): void {
  const from = task.agentName;
  const tried = [...new Set([...(task.triedAgents ?? [from]), from, toAgent])];
  tm.update(task.chatId, task.id, {
    agentName: toAgent,
    reassigns: (task.reassigns ?? 0) + 1,
    triedAgents: tried,
    sessionId: undefined,
  });
  const prev = task.state;
  tm.markRunning(task.chatId, task.id);
  publishStateChange(task, prev);
  say(
    task,
    `🔀 任务 ${taskRef(task)}：「${employeeDisplayName(from)}」这活儿不对口，我转给「${employeeDisplayName(toAgent)}」接手（${reason}）`,
  );
  void runWorker(task, handoff);
}

/**
 * 记一条用户反馈。归属到任务时带上员工与现场快照，供复盘回到 trace 交叉核对。
 *
 * 特别注意 bossAssists：若一个任务上 boss 代答过、随后收到负反馈，
 * 很可能是**代答答错了**而非员工的问题——复盘要能区分这两者，否则会冤枉员工。
 */
function recordFeedback(
  msg: ChannelMessage,
  signal: "explicit" | "cancel" | "proposal_rejected",
  polarity: "positive" | "negative",
  task?: Task,
  text?: string,
): void {
  appendFeedback({
    time: new Date().toISOString(),
    chatId: msg.chatId,
    senderId: msg.senderId,
    ...(msg.senderName ? { senderName: msg.senderName } : {}),
    polarity,
    signal,
    ...(task
      ? {
          taskId: task.id,
          agentName: task.agentName,
          ...(task.sessionId ? { sessionId: task.sessionId } : {}),
          context: {
            state: task.state,
            ...(task.bossAssists ? { bossAssists: task.bossAssists } : {}),
            ...(task.reassigns ? { reassigns: task.reassigns } : {}),
            ...(task.autoContinues ? { autoContinues: task.autoContinues } : {}),
          },
        }
      : {}),
    ...(text ? { text } : {}),
  });
}

/**
 * 「步数用满」的统一处理：预算内自动续跑，用尽才转 waiting_user 问用户。
 * 返回 true = 已接管本次收尾，调用方直接 return。
 *
 * **两条路都必须走这里**：SDK 既可能把步数用满作为 error result 流出，也可能在结果之后
 * 直接抛错——进程非零退出时它会把退出错误替换成结果文本再 throw
 * （`Claude Code returned an error result: Reached maximum number of turns (N)`）。
 * 早先只在 result 分支判断，抛错那条就漏了，任务被误判「执行出错」，
 * maxTurns 从「检查点」退化回「硬墙」，自动续跑等于没生效。
 *
 * 调用前调用方必须已 release() 并发令牌（续跑会重新申请）。
 */
function handleMaxTurns(
  task: Task,
  errorText: string,
  subtype: string | undefined,
  sessionId?: string,
): boolean {
  const isMaxTurns =
    subtype === "error_max_turns" || /maximum number of turns/i.test(errorText);
  if (!isMaxTurns) return false;

  const used = task.autoContinues ?? 0;
  if (used < config.maxAutoContinues) {
    tm.update(task.chatId, task.id, { autoContinues: used + 1, sessionId });
    say(
      task,
      `⏳ 任务 ${taskRef(task)}：这轮步数用满了，我让「${employeeDisplayName(task.agentName)}」接着跑（第 ${used + 1}/${config.maxAutoContinues} 次续跑）`,
    );
    void runWorker(
      task,
      "上一轮步数用满被中断，现在继续。已经做完的步骤不要重做，先说一句当前进展，然后直奔剩下的事情，尽快收尾交卷。",
    );
    return true;
  }

  const prev = task.state;
  const question = `这活儿已经跑满 ${used + 1} 轮步数额度还没收尾，我先停下来问问你：要继续吗？回「继续」我就接着跑；也可以缩小范围/调整方向，或者用 /cancel ${task.id} 取消。`;
  tm.markWaiting(task.chatId, task.id, question, sessionId);
  publishStateChange(task, prev);
  // 这里不走 escalate：步数用满有一组固定选项，卡片按钮是写死的而非来自员工的 askInputs
  say(
    task,
    withMention(task, askBody(task, question)),
    makeCard(`${taskRef(task)} 步数用满了`, question, [
      { title: "继续跑", reply: `#${task.id} 继续` },
      { title: "缩小范围收尾", reply: `#${task.id} 别再展开了，就现有进展尽快收尾交卷` },
      // 取消走 /cancel 确定性快路径，不经 LLM 分类
      { title: "取消任务", reply: `/cancel ${task.id}` },
    ]),
  );
  return true;
}

/**
 * 后台执行一个任务的一轮（首次执行或用户回答后 resume）。
 * 关键信号：本轮出现提问工具调用 → 判定 waiting_user（员工暂停等回答，仍占用）；
 * 否则视为完成。结束后若员工空出，出队下一个排队任务。
 * restoreWaitingOnError：本轮是「用户回答待确认问题」的 resume 时置 true——执行失败则任务
 * 退回 waiting_user（保留原问题），用户可重新回答，而不是判失败丢上下文。
 */
async function runWorker(
  task: Task,
  promptText: string,
  opts?: { restoreWaitingOnError?: boolean; scheduled?: boolean },
): Promise<void> {
  const agent = getAgent(task.agentName);
  if (!agent) {
    tm.markFailed(task.chatId, task.id, `未知 agent: ${task.agentName}`);
    say(task, `${mention(task)}任务 #${task.id} 失败：员工「${employeeDisplayName(task.agentName)}」不存在`);
    return;
  }
  // TTL 锚点刷新。放在 runWorker 而不是七处 markRunning：这里是所有真实执行的唯一收口
  touchTempWorker(task.agentName);

  // 全局并发闸门：拿到令牌才真正执行（拿不到则挂起等待，不占资源）
  await runGate.acquire();
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      runGate.release();
    }
  };

  const textParts: string[] = [];
  let sawQuestion = false;
  const askInputs: unknown[] = [];
  /** 显式交卷（report_task_done）的结构化入参；undefined = 本轮没交卷 */
  let reportInput: unknown;
  let sessionId = task.sessionId;
  let resultError: string | undefined;
  /** error result 的 subtype：用于区分「步数用满」这类可续跑中断与真异常 */
  let resultSubtype: string | undefined;
  let resultRetryable: boolean | undefined;
  let resultErrorSource: "model_gateway" | "runtime" | undefined;
  let resultStatusCode: number | undefined;

  // 注册打断手柄：用户中途插话时 abort 本轮，随后用新输入重新 runWorker
  const myRun: InflightRun = { controller: new AbortController(), interrupted: false };
  const cleanupInflight = registerRun(task.chatId, task.id, myRun);

  /**
   * 任务失败收尾。两种语义分开表达：
   * - exception：真异常（网络/鉴权/崩溃），文本短，截断无损
   * - rejected：boss 验收判定未完成，errorText 是**完整验收报告**，不能按异常那样砍到几百字
   */
  const failTask = (
    errorText: string,
    kind: "exception" | "rejected" = "exception",
  ): void => {
    const prev = task.state;
    const shown =
      kind === "rejected"
        ? truncate(errorText, 2500, task.id)
        : truncate(errorText, 800, task.id);
    if (opts?.restoreWaitingOnError && task.question) {
      // 用户的回答执行失败：任务退回等待态、问题保留，回复一次即可重试
      tm.markWaiting(task.chatId, task.id, task.question, sessionId);
      publishStateChange(task, prev);
      say(
        task,
        `${mention(task)}处理你对任务 ${taskRef(task)} 的回答时出错了：${shown}\n任务仍在等你确认，稍后重新回复一次即可。`,
      );
      return;
    }
    tm.markFailed(task.chatId, task.id, errorText);
    publishStateChange(task, prev);
    say(
      task,
      withMention(
        task,
        kind === "rejected"
          ? `#### ⚠️ 任务 ${taskRef(task)} 未通过验收\n\n${shown}`
          : `#### ❌ 任务 ${taskRef(task)} 执行出错\n\n${shown}`,
      ),
    );
    advanceEmployee(task.chatId, task.agentName);
  };

  /**
   * 失败收口：**每个报错都先让主管看一眼**，再决定重试还是收手。
   *
   * 与旧实现的区别：原先靠 `looksTransient` 一张关键词表判「能不能重试」，表上没有的
   * 新错误一律判死，且把网关原文直接贴给用户（`[500] {"message":"...aws-marketplace..."}`
   * 这种东西）。错误文本来自网关 / runtime / MCP / 各家 SDK，形态无穷且随上游变，
   * 关键词表永远追不上；而「这段话是不是在说临时故障」正是模型判得比正则准的事。
   *
   * 关键词表保留为**兜底**：诊断本身也要过网关，网关正挂着时这一跳同样会失败，
   * 那时必须还有个不依赖模型的判断，否则「网关挂了」会连带「判不了该不该重试」。
   *
   * 返回 true = 已接手（安排了重试 / 已判失败并播报），调用方直接 return。
   */
  const recoverOrFail = async (
    errorText: string,
    explicitlyRetryable?: boolean,
  ): Promise<boolean> => {
    const used = task.errorRetries ?? 0;
    const remaining = Math.max(TRANSIENT_RETRY_DELAYS_MS.length - used, 0);

    let diagnosis: FailureDiagnosis | undefined;
    try {
      diagnosis = await diagnoseFailure({
        errorText,
        displayName: employeeDisplayName(task.agentName),
        taskRef: taskRef(task),
        brief: task.brief ?? task.prompt,
        chatId: task.chatId,
        taskId: task.id,
        agentName: task.agentName,
        ...(resultErrorSource ? { errorSource: resultErrorSource } : {}),
        ...(resultStatusCode ? { statusCode: resultStatusCode } : {}),
        attempts: used,
        remaining,
      });
    } catch (error) {
      // 诊断这一跳自己挂了（多半正是网关的问题）→ 回落关键词兜底，别把判断权丢掉
      console.warn(`[boss] 失败诊断不可用，回落关键词判定:`, error);
    }

    const wantsRetry = diagnosis
      ? diagnosis.action === "retry"
      : (explicitlyRetryable ?? looksTransient(errorText));

    if (wantsRetry && remaining > 0) {
      // 模型给的延迟夹进合理区间：太短等于没等（上游没恢复），太长等于把任务挂死
      const delayMs = diagnosis?.delaySeconds
        ? Math.min(Math.max(diagnosis.delaySeconds, 5), 600) * 1000
        : TRANSIENT_RETRY_DELAYS_MS[used];
      tm.update(task.chatId, task.id, {
        state: "running",
        sessionId,
        errorRetries: used + 1,
        lastError: errorText,
        retryScheduledAt: Date.now() + delayMs,
      });
      say(
        task,
        `${mention(task)}⏳ 任务 ${taskRef(task)} 中断了：${diagnosis?.reason ?? (resultErrorSource === "model_gateway" ? "模型网关临时错误" : "临时错误")}\n` +
          `${Math.round(delayMs / 1000)} 秒后在原任务、原会话自动重试（${used + 1}/${TRANSIENT_RETRY_DELAYS_MS.length}）。`,
      );
      setTimeout(() => {
        // 读取最新状态：手动重试会把 retryScheduledAt 清掉并立即启动，不能再跑第二遍
        const fresh = tm.get(task.chatId, task.id);
        if (!fresh || fresh.state !== "running" || fresh.retryScheduledAt == null) return;
        tm.update(task.chatId, task.id, { retryScheduledAt: undefined });
        void runWorker(
          task,
          [
            "【系统自动恢复】上一轮因临时错误中断，现在继续同一个任务。",
            "优先依据会话里的检查点继续；先检查已有工具结果和外部状态，不要重复可能已成功的写操作。",
            `中断原因：${truncate(errorText, 500)}`,
            "",
            "若恢复后发现上下文不完整，以下是原始任务兜底：",
            task.brief ?? task.prompt,
          ].join("\n"),
          opts,
        );
      }, delayMs);
      return true;
    }

    // 收手：人话原因 + 建议在前，原文收在末尾（完整内容仍在任务详情与 trace 里）
    if (diagnosis) {
      failTask(
        [
          diagnosis.reason,
          diagnosis.advice ? `建议：${diagnosis.advice}` : "",
          used > 0 ? `（已在原任务、原会话自动重试 ${used} 次，仍未恢复）` : "",
          `原文：${truncate(errorText, 400)}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return true;
    }
    return false;
  };

  // 在办同侪清单只算一次（下面 params 要用）
  const siblings = siblingsBrief(task);

  try {
    for await (const e of agent.run({
      prompt: promptText,
      persistSession: true,
      abortController: myRun.controller,
      // resume 只认同源会话：切过 runtime 的异源 id 递下去会让 worker 致命失败
      // （Qoder 实测 exit 42 `Invalid session identifier`），详见 resumableSessionId
      ...(resumableSessionId(task, config.runtimeKind)
        ? { resume: resumableSessionId(task, config.runtimeKind) }
        : {}),
      params: {
        channel: task.channel,
        chatType: task.chatType,
        chatId: task.chatId,
        senderId: task.ownerSenderId,
        senderName: task.ownerSenderName,
        taskId: task.id,
        // 在办同侪清单：并发岗位（影分身）上该员工同时还有别的活，而那些活各自跑在独立
        // 会话里、彼此看不见。不告诉他的话，用户说一句像是那边延续的话，他只能当成全新
        // 需求从头做一遍。必须由 boss 注入——占用态是 boss 的账本，agents 层不能反向 import boss。
        ...(siblings ? { __siblings: siblings } : {}),
        // 定时任务标记：禁止在定时任务里再排定时任务（防 once 链无限自我增殖）
        ...(opts?.scheduled ? { scheduled: true } : {}),
      },
    })) {
      // 转发到事件总线：Dashboard SSE 用（不改主流程语义）
      publishAgentEvent(task, e);
      if (e.event === "text") textParts.push(e.data.text);
      else if (e.event === "session") {
        // 会话一建立就落盘 sessionId：中途被打断/进程重启后仍可 resume 到本轮上下文
        sessionId = e.data.sessionId;
        tm.update(task.chatId, task.id, { sessionId });
      } else if (e.event === "tool_call" && isAskTool(e.data.name)) {
        sawQuestion = true;
        askInputs.push(e.data.input);
      } else if (e.event === "tool_call" && e.data.name === REPORT_DONE_TOOL) {
        // 显式交卷：员工主动声明本轮收尾，附带结构化汇报
        reportInput = e.data.input;
      } else if (e.event === "progress" && e.data.status === "running") {
        // 里程碑播报：只报父步骤开始，避免刷屏
        if (!e.data.parentId) say(task, stepBroadcast(task, e.data));
      } else if (e.event === "result") {
        sessionId = e.data.sessionId ?? sessionId;
        if (e.data.isError) {
          // API/网关错误（如 401）会以 error result 流出，错误文本在 result 字段——
          // 绝不能当成员工的正常产出转发给用户
          resultError = e.data.result || `执行失败（${e.data.subtype}）`;
          resultSubtype = e.data.subtype;
          resultRetryable = e.data.retryable;
          resultErrorSource = e.data.errorSource;
          resultStatusCode = e.data.statusCode;
        }
      }
    }
  } catch (error) {
    cleanupInflight();
    release(); // 出错先放令牌
    if (myRun.interrupted) {
      // 用户主动打断：静默退出，不判失败——打断方随即会用新输入重新派发本任务
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // 步数用满常以抛错形式到这里（SDK 把进程退出错误替换成结果文本），先按预算续跑
    if (handleMaxTurns(task, message, resultSubtype, sessionId)) return;
    if (await recoverOrFail(message)) return;
    failTask(message);
    return;
  }
  cleanupInflight();

  // abort 可能不抛错而是流正常结束：被打断时同样静默退出，把任务留给新一轮
  if (myRun.interrupted) {
    release();
    return;
  }

  if (resultError) {
    release();
    // 步数用满不是失败：进度都在会话上下文里。先在预算内自动续跑，用尽才问用户。
    if (handleMaxTurns(task, resultError, resultSubtype, sessionId)) return;
    if (await recoverOrFail(resultError, resultRetryable)) return;
    // 只有诊断不可用（网关也挂了）才会走到这里：退回机械版式，至少把来源与状态码交代清楚
    if (resultErrorSource || resultStatusCode) {
      resultError = [
        `来源：${resultErrorSource === "model_gateway" ? "模型网关" : "运行时"}${resultStatusCode ? `（HTTP ${resultStatusCode}）` : ""}`,
        `原因：${resultError}`,
        resultRetryable
          ? `已在原任务、原会话自动重试 ${task.errorRetries ?? 0} 次，仍未恢复。`
          : "该错误不适合自动重试，请检查鉴权或配置。",
      ].join("\n");
    }
    failTask(resultError);
    return;
  }

  const finalText = textParts.join("").trim() || "（无输出）";

  if (sawQuestion) {
    // 关键：转 waiting_user 前释放令牌——等用户回答期间不占全局并发（否则会死锁）。
    // 员工槽位仍被占用（per-chat），下一任务不会派给该员工。
    release();
    // 只转发问题本身（含选项），不把员工的过程叙述全文带给用户；解析失败回落全文
    const question = formatAskUserQuestion(askInputs) ?? finalText;

    // boss 自主协调：用户已经说过的事不该再问他一遍。
    // 额度用尽后一律转人——代答是替用户做主，必须有天花板。
    const assists = task.bossAssists ?? 0;
    if (config.assist.enabled && assists < config.assist.maxSelfAnswers) {
      const decision = await triageQuestion(question, assistContext(task));

      if (decision.kind === "answer") {
        tm.update(task.chatId, task.id, { bossAssists: assists + 1, sessionId });
        const prevRun = task.state;
        tm.markRunning(task.chatId, task.id);
        publishStateChange(task, prevRun);
        // 知会而非询问：不阻塞用户，但让他有机会纠偏（决定权仍在他手上）
        say(
          task,
          `${mention(task)}💡 任务 ${taskRef(task)}：「${employeeDisplayName(task.agentName)}」问「${truncate(question, 60)}」，` +
            `我按你之前说的替你回了 —— ${decision.content}\n（依据：${truncate(decision.basis, 80)}；不对的话说一声，我让他改）`,
        );
        void runWorker(
          task,
          `【主管代为回答，依据用户已提供的信息】${decision.content}\n\n（依据：${decision.basis}）\n按这个继续做，不要再就同一件事提问。`,
          { restoreWaitingOnError: true },
        );
        return;
      }

      if (decision.kind === "reassign" && (task.reassigns ?? 0) < config.assist.maxReassigns) {
        applyReassign(
          task,
          decision.agentName,
          decision.reason,
          `${task.prompt}\n\n【主管补充：前一位同事在「${truncate(question, 80)}」这里卡住了，判断是派错人。请你从头按需求做，不要沿用他的思路。】`,
        );
        return;
      }
    }

    escalate(task, question, sessionId, askInputs);
    return;
  }

  // 显式交卷（report_task_done）：员工主动声明收尾 → 不再靠 LLM 猜「像不像完成」。
  // 交卷内容即权威汇报；outcome=cannot_complete 走「未完成」语义。
  if (reportInput) {
    release();
    // 先把结构化交卷存到任务上：done / 验收未过 / cannot_complete 三条路最终都会走到终态钩子，
    // 而钩子落工作台时要按字段取（conclusion / decisions / risks），不能去反解析渲染后的 markdown。
    tm.update(task.chatId, task.id, { report: reportInput as TaskReport });
    const report = renderTaskReport(reportInput) ?? finalText;
    if (isCannotComplete(reportInput)) {
      const ctx = assistContext(task);
      const reassignsLeft = (task.reassigns ?? 0) < config.assist.maxReassigns;
      // 确定性证据：真的没人可换了才准招人。这两条都由代码算出，
      // 不让模型自己判「团队里有没有人会」——它会为了不认输而招人
      const allowHire = ctx.candidates.length === 0 || !reassignsLeft;
      if (config.assist.enabled && (reassignsLeft || allowHire)) {
        const decision = await triageCapabilityGap(report, ctx, allowHire);
        if (decision.kind === "reassign" && reassignsLeft) {
          applyReassign(
            task,
            decision.agentName,
            decision.reason,
            `${task.prompt}\n\n【主管补充：前一位同事报告做不成，原因是不对口。他的说明：${truncate(report, 300)}\n请你按需求重新做。】`,
          );
          return;
        }
        if (decision.kind === "hire") {
          // 团队里没人会这项只读活儿 → boss「自己来」的方式：现招一个临时工
          const hired = opHireTempWorker({
            msg: taskAsMessage(task),
            capability: decision.capability,
            description: decision.description,
            systemPrompt: decision.systemPrompt,
            brief: task.brief ?? task.prompt,
            ...(decision.tools?.length ? { tools: decision.tools } : {}),
            ...(decision.readRoots?.length ? { readRoots: decision.readRoots } : {}),
          });
          say(
            task,
            hired.ok
              ? `${mention(task)}任务 ${taskRef(task)} 团队里确实没有对口的同事（${decision.reason}）。` +
                  `我现招了一位临时工「${hired.displayName}」接手，新任务 #${hired.taskId}。\n` +
                  `他拿到的是${hired.highPriv ? `可动手权限（${hired.highPriv}），写入限于他自己的工作目录` : "只读权限"}，不进团队名册，干完就释放。`
              : `${mention(task)}任务 ${taskRef(task)} 没人能接，我想现招个临时工也没成：${hired.reason}`,
          );
          failTask(report, "rejected");
          return;
        }
      }
      failTask(report, "rejected");
      return;
    }

    // 交卷也要过验收。顺序刻意是「先硬校验、后模型」：声明要产出的文件在不在，
    // 是 fs 一次调用能定论的事，不该交给单轮无工具的文本判断去猜
    // （实测员工声称落盘、实际被写门禁拦下的情况反复出现，而验收全程没察觉）。
    release();
    const missing = contractMissing(task);
    const submitVerdict = await reviewEmployeeOutput(
      employeeDisplayName(task.agentName),
      task.prompt,
      report,
      { chatId: task.chatId, taskId: task.id, agentName: task.agentName },
      {
        submitted: true,
        ...(task.acceptance ? { acceptance: task.acceptance } : {}),
        ...(missing.length ? { contractMissing: missing } : {}),
      },
    );
    if (submitVerdict.status === "failed") {
      // 交卷路径的追问预算单独给 1 轮：员工在返工轮里照样能提问，路径更长更烧
      handleRejected(submitVerdict, 1, report);
      return;
    }
    const prevDone = task.state;
    // 档案存全量模板（工作台 / 复盘 / 任务详情都按字段取），聊天只发按汇报风格
    // 组织过的那一版——精简的是视图，不是数据。summary 缺失时回落模板，绝不发空。
    tm.markDone(task.chatId, task.id, report, sessionId);
    publishStateChange(task, prevDone);
    say(
      task,
      withMention(
        task,
        wrapResult(task.agentName, taskRef(task), pickDeliveryText(submitVerdict.summary, report)),
      ),
    );
    afterTaskDone(task, report);
    advanceEmployee(task.chatId, task.agentName);
    return;
  }

  // 既没提问也没交卷（Stop hook 拦过一次仍不配合）：boss 验收裁决兜底。
  // 验收与 leader 汇报摘要同一次轻量调用。先放令牌——验收是 boss 的活，不占员工并发额度。
  release();
  const fallbackMissing = contractMissing(task);
  const verdict = await reviewEmployeeOutput(
    employeeDisplayName(task.agentName),
    task.prompt,
    finalText,
    { chatId: task.chatId, taskId: task.id, agentName: task.agentName },
    {
      // 这条路径不带 submitted：员工没交卷，needs_user 仍是合法结论，异常仍 fail-closed
      ...(task.acceptance ? { acceptance: task.acceptance } : {}),
      ...(fallbackMissing.length ? { contractMissing: fallbackMissing } : {}),
    },
  );

  if (verdict.status === "needs_user") {
    const question = verdict.question!;
    // 与员工主动提问同一套护栏：用户已经说过的事不该再问一遍
    const assists = task.bossAssists ?? 0;
    if (config.assist.enabled && assists < config.assist.maxSelfAnswers) {
      const decision = await triageQuestion(question, assistContext(task));
      if (decision.kind === "answer") {
        tm.update(task.chatId, task.id, { bossAssists: assists + 1, sessionId });
        const prevRun = task.state;
        tm.markRunning(task.chatId, task.id);
        publishStateChange(task, prevRun);
        say(
          task,
          `${mention(task)}💡 任务 ${taskRef(task)}：验收时发现还缺「${truncate(question, 60)}」，` +
            `我按你之前说的补上了 —— ${decision.content}\n（依据：${truncate(decision.basis, 80)}；不对的话说一声）`,
        );
        void runWorker(
          task,
          `【主管补充信息，依据用户已提供的内容】${decision.content}\n\n（依据：${decision.basis}）\n按这个把任务收尾。`,
          { restoreWaitingOnError: true },
        );
        return;
      }
    }
    escalate(task, question, sessionId);
    return;
  }

  /**
   * 验收不通过的统一出口：先回头找员工返工，预算用尽才判失败。
   *
   * 抽成闭包是因为交卷路径和这条兜底路径都要用它，而两边的返工预算不同
   * （交卷路径只给 1 轮）。复制一份必然漂移。
   */
  function handleRejected(verdict: ReviewVerdict, budget: number, text: string): void {
    const rounds = task.reviewRounds ?? 0;
    if (rounds < budget) {
      // 沿用员工原 session（他有完整上下文），追问带上验收结论让他知道差在哪
      tm.update(task.chatId, task.id, { reviewRounds: rounds + 1, sessionId });
      const prevRun = task.state;
      tm.markRunning(task.chatId, task.id);
      publishStateChange(task, prevRun);
      const gap = verdict.summary || text || "本轮没有可验收的产出";
      say(
        task,
        `${mention(task)}🔍 任务 ${taskRef(task)} 验收没通过，我先找「${employeeDisplayName(task.agentName)}」确认下（第 ${rounds + 1}/${budget} 次追问）。`,
      );
      void runWorker(
        task,
        [
          "【主管追问】我验收了你这一轮的产出，判定是「未完成」。验收意见如下：",
          truncate(gap, 1000),
          "",
          "请二选一，不要沉默：",
          "1. 如果是你能自己解决的（漏了步骤/产出没写清/验证没做）→ 直接补齐并重新交卷。",
          `2. 如果确实卡住了（缺权限/缺信息/环境不通/工具报错）→ 说清**具体**卡在哪一步、报错原文是什么，然后按「无法完成」交卷，或用提问工具向用户求助。`,
          "不要重复上一轮的空转，也不要只说「我再试试」。",
        ].join("\n"),
        { restoreWaitingOnError: true },
      );
      return;
    }
    // 预算用尽：如实告知已追问过几轮仍未通过
    failTask(
      [verdict.summary || text, "", `（主管已追问 ${rounds} 轮，仍未拿到可验收的产出）`].join("\n"),
      "rejected",
    );
  }

  if (verdict.status === "failed") {
    handleRejected(verdict, config.assist.maxReviewRetries, finalText);
    return;
  }

  const prev = task.state;
  tm.markDone(task.chatId, task.id, finalText, sessionId);
  publishStateChange(task, prev);
  // 员工产出原样透传（验收已通过，不重写以免技术结论失真）
  say(task, withMention(task, wrapResult(task.agentName, taskRef(task), finalText)));
  afterTaskDone(task, finalText);
  advanceEmployee(task.chatId, task.agentName);
}

/**
 * 任务验收通过后的收尾推送（两条 done 路径共用）。
 * 优化员的产物是待审提案：紧跟一条推送，否则提案只会烂在目录里没人看见。
 *
 * 刻意**不**在这里问「这个临时工要不要转正」：首个任务刚完成时没有任何证据表明
 * 这个能力会再被需要，一任务一临时工 × 一临时工一提案 = 每个无人可派的任务都弹一次。
 * 该问的是「这类活已经出现三次了，要不要设个岗」——由归纳闸门发起（scheduler.scan）。
 */
function afterTaskDone(task: Task, _output: string): void {
  if (task.agentName !== "optimizer") return;
  const brief = pendingProposalsBrief();
  if (brief) say(task, `${mention(task)}${brief}`, pendingProposalsCard());
}

/**
 * 员工空出槽位后，把他队列里的活尽量填满。
 *
 * 必须是循环而不是取一个：并发槽下一次可能同时腾出多个空位（两个任务先后终态、
 * 或用户一次回答放行了多个），只派一个会让剩下的活白等到下一次事件才被想起来。
 * `dequeueNext` 取到任务时会把它置为 running（占掉一个槽），所以下一轮重算
 * `freeSlots` 必然递减 → 自然收敛，不会空转。
 */
function advanceEmployee(chatId: string, agentName: string): void {
  for (;;) {
    const next = tm.dequeueNext(chatId, agentName);
    if (!next) return;
    say(next, `▶️ 开始处理排队任务 ${taskRef(next)}`);
    void runWorker(next, workerPrompt(next));
  }
}

/**
 * 落一条工作台记录 + 一条长期归档（两者同源、同一处收口）。
 *
 * 为什么两份而不是一份：工作台是 `agent × chat` 的**注入索引**（60 天、开场就进上下文），
 * 归档是**长期档案**（不设 TTL、按月分片、靠工具按需查）。同一份数据担不了两个角色——
 * 索引必须小而近，档案必须全而久。但**写入只能有这一个收口**，散开就会漂。
 *
 * 挂在终态钩子上而不是 runWorker 的各个出口：钩子是**所有**终态的唯一收口
 * （`task-manager.setState`），交卷完成、验收未过、执行出错、用户取消、重启补交接
 * 全都流经这里；散在 runWorker 里就要改五处，且覆盖不到重启那条。
 *
 * 终态事件**会重复来**（验收返工让任务多次进出 running、`retryFailed` 复活失败任务、
 * `recoverPendingHandoffs` 主动重放）——两边都不在写时去重，由读侧按 taskId
 * 后写的赢。理由是守住 append-only：写前查重就得先读全文，那又变回 read-modify-write 了。
 *
 * **排除 scheduled 任务**：复盘/优化这类每天都跑，几天就能把索引占满，把真正的用户任务
 * 挤出注入窗口——`Task.scheduled` 那段注释记的就是同类事故（boss 只看得到复盘任务，
 * 于是答出与用户诉求完全不相干的东西）。归档同样排除：定时任务的历史价值远低于它的体量。
 */
function recordTaskHistory(task: Task, to: TaskState): void {
  if (task.scheduled) return;
  if (to !== "done" && to !== "failed" && to !== "cancelled") return;
  const agent = getAgent(task.agentName);
  const at = Date.now();
  const title = (task.brief ?? task.prompt).split("\n")[0] ?? "";
  const report = task.report;
  appendWorkbench(task.agentName, task.chatId, {
    taskId: task.id,
    at,
    state: to,
    title,
    ...(report?.conclusion ? { conclusion: report.conclusion } : {}),
    ...(report?.deliverables ? { deliverables: report.deliverables } : {}),
    ...(report?.verification ? { verification: report.verification } : {}),
    ...(report?.risks ? { risks: report.risks } : {}),
    ...(report?.decisions ? { decisions: report.decisions } : {}),
    // 没交卷就失败时结论只剩报错（这类记录同样有价值：下次别再走同一条死路）
    ...(!report && task.error ? { error: task.error } : {}),
    ...(agent ? { noteFile: agent.noteFilePathFor(task.id) } : {}),
  });
  appendTaskArchive({
    taskId: task.id,
    chatId: task.chatId,
    at,
    state: to,
    agentName: task.agentName,
    ...(agent ? { agentKind: agent.agentKind() } : {}),
    ...(task.channel ? { channel: task.channel } : {}),
    title,
    ...(report?.conclusion ? { conclusion: report.conclusion } : {}),
    ...(report?.deliverables ? { deliverables: report.deliverables } : {}),
    ...(report?.verification ? { verification: report.verification } : {}),
    ...(report?.risks ? { risks: report.risks } : {}),
    ...(report?.decisions ? { decisions: report.decisions } : {}),
    ...(!report && task.error ? { error: task.error } : {}),
    ...(task.acceptance ? { acceptance: task.acceptance } : {}),
    ...(task.reassigns ? { reassigns: task.reassigns } : {}),
    ...(agent ? { noteFile: agent.noteFilePathFor(task.id) } : {}),
  });
}

/**
 * 串行编排接线：任务进终态时决定它的后继怎么走。
 *
 * 在模块加载时就接上，**不能放进某个 start 函数**——重启恢复会批量改任务状态，
 * 那批终态发生在任何 start 之前，注册晚了就静默漏掉。
 *
 * `hold` 直接复用 `escalate`：「挂起等用户回话」的状态迁移、@ 提醒、可点按钮
 * 那套逻辑已经在它里面了，再写一份只会漂移。
 *
 * 工作台落库排在交接**之前**：交接会把后继任务拉起来，而后继一开跑就要注入工作台索引——
 * 顺序反了的话它读到的是前置还没落库的旧索引，"等 A 干完再做 B"里 B 恰好看不到 A 的结论。
 */
tm.setTerminalHook((task, to) => {
  recordTaskHistory(task, to);
  onTaskTerminal(task, to);
});
setHandoffRuntime({
  effects: {
    say: (task, text) => say(task, withMention(task, text)),
    advance: advanceEmployee,
    hold: (task, question) => escalate(task, question, task.sessionId),
  },
});

/** 任务详情链接（Dashboard 会话页深链）：创建类回复统一附带，用户可点开看执行细节与进度 */
function taskLink(task: Task): string {
  return `\n📊 详情：${config.publicBaseUrl}/dashboard/sessions?chat=${encodeURIComponent(task.chatId)}&task=${task.id}`;
}

/**
 * 用户回答待确认问题时交给员工的输入。
 * 必须把「你问的什么」和「用户答的什么」绑在一起——只发裸回答（如单个词「Graphify」）
 * 会让员工自由联想出别的意图（实测：答「Graphify」被理解成「要 Graphify 的落地步骤」，
 * 而原问题是「和哪个工具做对比」）。resume 的会话上下文并不可靠，必须显式重述。
 */
function answerPrompt(question: string | undefined, answer: string): string {
  if (!question?.trim()) return answer;
  return [
    "【你上一轮向用户提出的问题】",
    question.trim(),
    "",
    "【用户的回答】",
    answer,
    "",
    "这是**对上述问题的回答**，不是新任务：把它填回原问题的位置，继续完成原本的任务目标，不要另起话题、不要自行扩展成别的诉求。",
  ].join("\n");
}

/**
 * 该员工在本 chat **除当前任务外**其它占用中任务的一行清单（无则 undefined）。
 *
 * 走 `params.__siblings` 进系统提示，而不是拼到 `workerPrompt` 的用户消息里：这是环境
 * 事实（"你还有别的活在手上"）而非任务内容，混进用户消息会被模型当成需求的一部分复述给用户。
 */
function siblingsBrief(task: Task): string | undefined {
  const others = tm
    .occupyingTasks(task.chatId, task.agentName)
    .filter((t) => t.id !== task.id && !t.scheduled);
  if (others.length === 0) return undefined;
  return others
    .map((t) => {
      const state = t.state === "waiting_user" ? "等用户确认中" : "正在进行";
      const title = (t.brief ?? t.prompt).split("\n")[0]?.slice(0, 60) ?? "";
      return `- ${taskRef(t)}（${state}）：${title}`;
    })
    .join("\n");
}

/** 首次派发给员工的完整输入：主管派工简报（如有）+ 用户原话（原话必须原样携带，简报只是导读） */
function workerPrompt(task: Task): string {
  return task.brief
    ? `【主管派工简报】\n${task.brief}\n\n【用户原话】\n${task.prompt}`
    : task.prompt;
}

/**
 * 产出合约硬校验：返回缺失项（空 = 没声明合约或都在）。**零模型调用**。
 *
 * 必须按承接员工的工作目录解析：员工声明的是相对路径，而 per-chat / per-run 策略下
 * 工作目录是分桶的，猜不对就会去查一个错的目录、把在的文件报成不在。
 */
function contractMissing(task: Task): string[] {
  if (!task.contract) return [];
  const agent = getAgent(task.agentName);
  if (!agent) return [];
  const cwd = agent.resolveRunCwd({
    prompt: task.prompt,
    params: { chatId: task.chatId, taskId: task.id },
  });
  return missingContractFiles(task.contract, cwd);
}

/**
 * 截断长文。带 taskId 时给出显式截断说明——裸 `…` 会让用户分不清
 * 「被系统截断」还是「模型自己写完了」。
 */
function truncate(s: string, n: number, taskId?: string): string {
  if (s.length <= n) return s;
  const note = taskId
    ? `\n\n…（内容过长已截断 ${s.length - n} 字，完整内容见任务 #${taskId} 记录）`
    : "…";
  return `${s.slice(0, n)}${note}`;
}

/** /status 看板 */
function statusBoard(chatId: string): string {
  const active = tm.activeTasks(chatId);
  if (active.length === 0) return "当前没有进行中的任务。";
  const label: Record<string, string> = {
    running: "执行中",
    waiting_user: "等你确认",
    queued: "排队中",
  };
  return [
    "当前任务：",
    ...active.map(
      (t) => `- ${taskRef(t)} [${label[t.state] ?? t.state}] ${employeeDisplayName(t.agentName)}`,
    ),
  ].join("\n");
}

/**
 * 处理完消息后，重播仍未确认的问题（排除刚处理的）。
 *
 * **问题正文不截断**。这条消息的唯一目的是让用户能当场回答，而问题里最关键的部分
 * （「1. 加进去 / 2. 不加」这类选项）通常在末尾——之前截到 150 字符，选项正好被砍掉，
 * 用户只看到一句残缺的疑问句，没法确认，提醒本身就废了。占屏也比看不懂强。
 */
function remindWaiting(chatId: string, excludeIds: Set<string>): void {
  const pending = tm.waitingTasks(chatId).filter((t) => !excludeIds.has(t.id));
  if (pending.length === 0) return;

  if (pending.length === 1) {
    const t = pending[0];
    say(t, `📌 还有一个待你确认的问题 — ${taskRef(t)}：\n\n${t.question ?? ""}`);
    return;
  }
  // 多条：全文列出，用分隔线隔开并各自标任务号，否则用户不知道哪个答案对应哪个任务
  const blocks = pending.map(
    (t) => `【${taskRef(t)}】${employeeDisplayName(t.agentName)}在等：\n${t.question ?? ""}`,
  );
  say(
    pending[0],
    `📌 还有 ${pending.length} 个待你确认的问题（回答时请带上任务号）：\n\n${blocks.join("\n\n———\n\n")}`,
  );
}

/**
 * per-chat 串行锁：boss 与同一 chat 共享一个会话，两个 turn 并发会把 messages 写乱。
 * 用一条 promise 链把同 chat 的消息排队。
 */
const chatLocks = new Map<string, Promise<void>>();

function withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chatLocks.get(chatId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chatLocks.set(
    chatId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// ─── Inbox 消费注册（单一大脑的事件驱动入口）───────────────────

/**
 * 注册 inbox drain handler。启动时调用一次。
 *
 * 收到一批事件后逐个分类：awaken → runBossForEvent；mechanical → 旧降级路径。
 * 多事件合并为一次唤醒时，awaken 事件聚合到第一个事件里。
 */
export function initBossInbox(): void {
  setInboxDrainHandler(async (events) => {
    if (events.length === 0) return;
    const chatId = events[0].chatId;
    const candidates = listRoutableAgents();

    const toAwaken: InboxEvent[] = [];
    const toMechanical: Array<{ event: InboxEvent; handler: string }> = [];

    for (const event of events) {
      const chatState: ChatState = {
        assistUsed: 0,
        assistMax: config.assist.maxSelfAnswers,
      };
      const result = classifyEvent(event, chatState);
      if (result.action === "awaken") {
        toAwaken.push(event);
      } else if (result.action === "mechanical") {
        toMechanical.push({ event, handler: result.handler });
      }
    }

    for (const { event, handler } of toMechanical) {
      try {
        await handleMechanical(event, handler);
      } catch (err) {
        console.error(`[inbox] mechanical handler ${handler} 失败:`, err);
      }
    }

    if (toAwaken.length > 0 && candidates.length > 0) {
      const primary = toAwaken[0];
      if (toAwaken.length > 1 && primary.kind !== "user_message" && primary.kind !== "system_error") {
        const extras = toAwaken.slice(1).map((e) => `${e.kind}(#${(e.payload as SystemEventPayload).task?.id ?? "?"})`);
        const payload = primary.payload as SystemEventPayload;
        payload.context = { ...payload.context, additionalEvents: extras };
      }
      // 处理基础设施错误期间抑制上报：boss 自己的工具再抛错就会无限自激
      const isInfra = primary.kind === "system_error";
      if (isInfra) suppressCrashReporting();
      try {
        await withChatLock(chatId, async () => {
          await runBossForEvent(primary, candidates);
        });
      } finally {
        if (isInfra) resumeCrashReporting();
      }
    }
  });

  /**
   * 注册崩溃上报：把全局兜底捕获的错误交给 boss 判断影响面。
   *
   * crash-guard 已做去重 + 节流（同故障 10 分钟一次、每小时最多 6 次），
   * 这里只负责转成 inbox 事件。投递落点用系统级通知目标（错误不属于任何任务）。
   */
  setCrashReporter((report) => {
    const target = notifyTarget();
    enqueue({
      chatId: target.chatId,
      kind: "system_error",
      priority: "low", // 低优先级：用户消息和任务事件都该排在它前面
      payload: {
        source: report.source,
        errorText: report.errorText,
        occurrences: report.occurrences,
        context: {},
      } as InfraEventPayload,
    });
  });
}

async function handleMechanical(event: InboxEvent, handler: string): Promise<void> {
  const payload = event.payload as SystemEventPayload;
  const task = payload.task;
  switch (handler) {
    case "review_fallback": {
      const output = String(payload.context.output ?? "");
      const verdict = await reviewEmployeeOutput(
        employeeDisplayName(task.agentName),
        task.prompt,
        output,
        { chatId: task.chatId, taskId: task.id, agentName: task.agentName },
        { submitted: true, ...(task.acceptance ? { acceptance: task.acceptance } : {}) },
      );
      if (verdict.status === "completed") {
        const prev = task.state;
        tm.markDone(task.chatId, task.id, output);
        publishStateChange(task, prev);
        say(task, withMention(task, wrapResult(task.agentName, taskRef(task), output)));
        advanceEmployee(task.chatId, task.agentName);
      } else {
        const prev = task.state;
        tm.markFailed(task.chatId, task.id, verdict.summary || "验收未通过");
        publishStateChange(task, prev);
        say(task, `${mention(task)}❌ 任务 ${taskRef(task)} 验收未通过：${verdict.summary ?? "未知原因"}`);
      }
      break;
    }
    case "diagnose_fallback": {
      const errorText = String(payload.context.errorText ?? "");
      const used = Number(payload.context.retries ?? 0);
      const remaining = Math.max(TRANSIENT_RETRY_DELAYS_MS.length - used, 0);
      let diagnosis: FailureDiagnosis | undefined;
      try {
        diagnosis = await diagnoseFailure({
          errorText,
          displayName: employeeDisplayName(task.agentName),
          taskRef: taskRef(task),
          brief: task.brief ?? task.prompt,
          chatId: task.chatId,
          taskId: task.id,
          agentName: task.agentName,
          attempts: used,
          remaining,
        });
      } catch { /* 诊断也挂了 */ }
      if (!(diagnosis?.action === "retry" && remaining > 0)) {
        const prev = task.state;
        tm.markFailed(task.chatId, task.id, diagnosis?.reason ?? errorText.slice(0, 500));
        publishStateChange(task, prev);
        say(task, `${mention(task)}❌ 任务 ${taskRef(task)} 失败：${diagnosis?.reason ?? errorText.slice(0, 200)}`);
      }
      break;
    }
    case "handoff_fallback": {
      const successors = (payload.context.successors ?? []) as Array<{ id: string; brief: string }>;
      for (const s of successors) {
        const successor = tm.get(task.chatId, s.id);
        if (successor) advanceEmployee(task.chatId, successor.agentName);
      }
      break;
    }
    case "escalate_to_user": {
      const question = String(payload.context.question ?? "");
      say(task, `${mention(task)}❓ 任务 ${taskRef(task)}：${question}`);
      break;
    }
  }
}

/**
 * 向 inbox 发射系统事件。runWorker 完成/失败路径调用此函数替代内联 review/diagnose。
 */
export function emitSystemEvent(
  kind: InboxEvent["kind"],
  task: Task,
  context: Record<string, unknown>,
  causedByBossAction?: string,
): void {
  enqueue({
    chatId: task.chatId,
    kind,
    priority: "normal",
    payload: { task, context } as SystemEventPayload,
    ...(causedByBossAction ? { causedByBossAction } : {}),
  });
}

/**
 * Boss 入口。
 *
 * 架构：**会话是入口，派活/转达/取消都是工具**（见 boss-agent.ts）。
 * 进 agent 之前先过一层纯正则的确定性匹配——零成本、100% 可靠，
 * 这类消息（/status、/cancel、提案审批、答题卡回填）归属已写在文本里，没必要让模型判。
 */
export async function bossHandle(msg: ChannelMessage, reply: ReplyFn): Promise<void> {
  setActiveReply(msg.chatId, reply);

  const candidates = listRoutableAgents();
  if (candidates.length === 0) {
    await reply(`当前没有可用的员工 agent`);
    return;
  }

  const fast = matchDeterministicIntent(msg.text, tm.waitingTasks(msg.chatId));
  if (fast && (await handleDeterministic(msg, reply, fast.segments, candidates))) return;

  // 反馈识别走旁路：不阻塞回复，也不占 boss 的对话上下文
  void classifyFeedback(msg.text, tm.recentFinishedTasks(msg.chatId), msg.chatId).then((fb) => {
    if (!fb) return;
    const target = fb.taskId ? tm.get(msg.chatId, fb.taskId) : undefined;
    recordFeedback(msg, "explicit", fb.polarity, target, fb.text);
  });

  await withChatLock(msg.chatId, async () => {
    // 登记这一轮：进程若在中途重启，启动时的 recover 会扫出来并告知用户
    // （boss 轮次不是 Task，没有状态机兜底，不登记就是静默丢失）
    markTurnStart({
      channel: msg.channel,
      chatId: msg.chatId,
      chatType: msg.chatType,
      ownerSenderId: msg.senderId,
      ...(msg.senderName ? { ownerSenderName: msg.senderName } : {}),
      text: msg.text,
      startedAt: Date.now(),
    });
    try {
      const out = await runBossAgent(msg, candidates);
      await reply(
        out.isError
          ? `抱歉，我这边处理出了点问题：${out.text.slice(0, 200)}`
          : out.text || "（我这边没组织出回复，你再说一次？）",
      );
    } finally {
      markTurnEnd(msg.chatId);
    }
  });
  remindWaiting(msg.chatId, new Set<string>());
}

/**
 * 确定性片段执行。返回 false 表示没吃下这条消息（如答题卡指向的任务已不在等待态），
 * 由调用方回落给 agent 判断——比在这里硬猜要准。
 */
async function handleDeterministic(
  msg: ChannelMessage,
  reply: ReplyFn,
  segments: IntentSegment[],
  candidates: BaseAgent[],
): Promise<boolean> {
  const handledIds = new Set<string>();

  for (const seg of segments) {
    if (seg.kind === "task_op") {
      if (seg.op === "status") {
        await reply(statusBoard(msg.chatId));
      } else {
        const out = opCancelTask(msg, seg.taskId);
        await reply(out.ok ? `已取消任务 #${out.taskId}` : `未找到可取消的任务 #${seg.taskId}`);
      }
      continue;
    }

    if (seg.kind === "proposal_op") {
      if (seg.op === "list") {
        await reply(pendingProposalsBrief() ?? "当前没有待审的提案。", pendingProposalsCard());
      } else if (seg.op === "apply") {
        const isPrompt = (getProposal(seg.proposalId)?.kind ?? "prompt") === "prompt";
        const r = applyProposal(seg.proposalId);
        await reply(
          r.ok
            ? isPrompt
              ? `✅ ${r.message}\n下次派活即生效。若发现效果不好，说「回退 ${seg.proposalId}」还原。`
              : `✅ ${r.message}`
            : `❌ ${r.message}`,
        );
      } else if (seg.op === "reject") {
        const rejected = getProposal(seg.proposalId);
        const r = rejectProposal(seg.proposalId);
        // 行为信号：改提示词提案被驳回 = 优化师归因看错了，记在它自己头上。
        // 建岗提案被驳回不算它的错（是团队规模判断），台账已标 declined，不再重复来问
        if (r.ok && rejected && (rejected.kind ?? "prompt") === "prompt") {
          recordFeedback(
            msg,
            "proposal_rejected",
            "negative",
            undefined,
            `驳回提案 ${seg.proposalId}（目标员工 ${rejected.agentId}）：${rejected.summary}`,
          );
        }
        await reply(r.message);
      } else {
        await reply(revertProposal(seg.proposalId).message);
      }
      continue;
    }

    if (seg.kind === "case_op") {
      if (seg.op === "list") {
        await reply(pendingApprovalsBrief() ?? "当前没有待审的回归用例。");
      } else {
        const found = resolveApproval(seg.caseRef);
        if (!found) {
          await reply(`没找到待审用例 ${seg.caseRef}。回「待审用例」看清单。`);
        } else if (seg.op === "approve") {
          const r = approveByRef(found);
          await reply(
            r.ok
              ? `✅ ${r.message}\n从现在起它是 ${found.agentId} 的永久回归标准，退回去会立刻被拦。`
              : `❌ ${r.message}`,
          );
        } else {
          await reply(discardByRef(found).message);
        }
      }
      continue;
    }

    // reply：「#任务号 内容」，归属已写明
    const answered = await opAnswerEmployeeQuestion({
      msg,
      taskId: seg.taskId,
      content: seg.content,
      candidates,
    });
    if (!answered.ok) return false;
    handledIds.add(answered.taskId);
    await reply(
      answered.rerouted
        ? `明白了，交给「${answered.displayName}」处理（任务 #${answered.taskId}）…`
        : `收到，继续处理任务 #${answered.taskId}…`,
    );
  }

  remindWaiting(msg.chatId, handledIds);
  return true;
}

/** 派发操作的结构化结果（供工具层回给模型，也供旧路径拼播报） */
export interface DispatchOutcome {
  taskId: string;
  agentName: string;
  displayName: string;
  /**
   * running=已开跑；queued=员工忙排队中；waiting_dep=按顺序排在前置任务之后；
   * waiting_clarify=路由拿不准，已挂起等用户确认方向。
   *
   * waiting_dep 必须与 queued 分开：调用方对 queued 的播报是「他正忙（在处理 #X）」，
   * 而等前置的任务没有 busyWithTaskId，复用 queued 会让 boss 对用户说
   * 「他正忙（在处理 #undefined）」。
   */
  state: "running" | "queued" | "waiting_dep" | "waiting_clarify";
  clarify?: string;
  /** queued 时：前面还排着几个 */
  aheadCount?: number;
  /**
   * queued 时：他手上正占着槽位的那些任务。
   *
   * 是数组而不是单个：开了并发槽的岗位可能同时在做多件活，只报一个会让 boss 对用户说
   * 「他正忙（在处理 #x）」——用户去看却发现还有个 #y，这是在说假话。
   */
  busyWithTaskIds?: string[];
  /** waiting_dep 时：在等哪个任务 */
  afterTask?: string;
}

/**
 * 「名册里没人能干」的拒派文案（派工与复核两条路径共用）。
 * 说清两种错法都不许：硬派给最像的人，或把诉求缩小成只读的半截活。
 */
function noFitError(reason: string): Error {
  return new Error(
    `名册里没有职责覆盖这件活的同事（${reason}）。不要硬派给最像的那个人，` +
      `也不要把用户的诉求缩小成只读的半截活来迁就现有的人——` +
      `改用 hire_temp_worker 现招一个临时工：纯查阅不填 tools（默认只读），` +
      `要改文件/跑命令就加 Write/Edit/Bash 并同时给 readRoots。多步接力（SOP 型）的派给 hr 设计。`,
  );
}

/**
 * 派新活（纯操作，不发任何面向用户的消息）。
 *
 * 与 handleNewTask 的分工：这里只负责「选人 + 建任务 + 开跑」并返回结构化结果；
 * 播报由调用方决定——agent 模式下 boss 自己的文本输出就是唯一回复，
 * 工具再发一条会变成双消息。
 */
export async function opDispatchTask(input: {
  msg: ChannelMessage;
  content: string;
  candidates: BaseAgent[];
  agent?: string;
  params?: Record<string, unknown>;
  clarify?: string;
  brief?: string;
  /** 前置任务 id：本任务排在它之后 */
  afterTask?: string;
  /** 验收标准（结构化留存） */
  acceptance?: string;
  /** 可机验的产出合约 */
  contract?: Contract;
  /** 本次指定的验收员（一次性覆盖岗位配置） */
  reviewer?: string;
}): Promise<DispatchOutcome> {
  const { msg, content, candidates } = input;
  // 顺序声明先校验：不合法就报错让模型改，**不能静默忽略**——静默丢掉顺序后
  // boss 会照常告诉用户「安排好了，等 A 干完就跑 B」，而实际上 B 立刻开跑了。
  //
  // 不需要环检测：afterTask 只在建任务时设置且必须指向**已存在**的任务，而本任务的 id
  // 此刻还没生成，没有任何既有任务能指向它——依赖天然是森林，成不了环。
  let afterTask = input.afterTask?.replace(/^#/, "");
  if (afterTask) {
    const dep = tm.get(msg.chatId, afterTask);
    if (!dep) {
      throw new Error(`前置任务 #${afterTask} 不存在（同一会话内才能排顺序），请先确认任务号`);
    }
    if (dep.state === "cancelled") {
      throw new Error(`前置任务 #${afterTask} 已被取消，排在它后面永远等不到，请改成直接派或换前置`);
    }
    // 前置已经收尾了 → 没什么可等的，退化成普通派工（不要建一个永远不会被交接唤醒的任务）
    if (["done", "failed"].includes(dep.state)) afterTask = undefined;
  }
  // 分诊+派工已合并：优先用上层给出的目标员工；缺失/非法时回落独立路由器
  let route: RouteResult;
  const preAgent = input.agent ? candidates.find((a) => a.name === input.agent) : undefined;
  if (preAgent && input.clarify) {
    // 澄清路径不复核：这个人选本来就只是等用户答复期间的占位承接人
    route = { agent: preAgent, params: input.params ?? {}, via: "clarify", clarify: input.clarify };
  } else if (preAgent) {
    /**
     * boss 自己挑了人也要过这道闸门。它跳过路由器时，「名册里没人能干」就永远无人判定，
     * 而 boss 绕开招人的方式恰恰是自己挑一个沾边的人（把要写入的活派给只读岗）。
     * 复核只否决 none 这一种结论——路由器选了别人不代表 boss 错了，仍尊重指定。
     */
    const audit = await routeAgent(content, candidates);
    if (audit.via === "none") throw noFitError(audit.reason);
    if (audit.agent.name !== preAgent.name) {
      console.log(`[boss] 复核倾向 ${audit.agent.name}，仍按指定派给 ${preAgent.name}`);
    }
    route = { agent: preAgent, params: input.params ?? {}, via: "llm" };
  } else {
    const routed = await routeAgent(content, candidates);
    if (routed.via === "none") throw noFitError(routed.reason);
    route = routed;
  }
  const { agent, via } = route;
  console.log(`[boss] ${msg.channel} route -> ${agent.name} (via ${via}${preAgent ? ", merged" : ""})`);

  // 路由拿不准：不硬派——建任务挂 waiting_user，先向用户确认方向。
  if (via === "clarify" && route.clarify) {
    const { task } = tm.create({
      channel: msg.channel,
      chatId: msg.chatId,
      chatType: msg.chatType,
      ownerSenderId: msg.senderId,
      ownerSenderName: msg.senderName ?? "",
      agentName: agent.name,
      prompt: content,
    });
    publishCreated(task);
    const prev = task.state;
    // 标记为澄清占位：从未派发过员工，收到答复后应「合并原诉求重新路由」。
    // 这是唯一合法的「答复→重路由」场景，其余 waiting_user 任务的答复都回到它自己的员工。
    tm.update(msg.chatId, task.id, { awaitingClarifyRoute: true });
    tm.markWaiting(msg.chatId, task.id, route.clarify);
    publishStateChange(task, prev);
    return {
      taskId: task.id,
      agentName: agent.name,
      displayName: employeeDisplayName(agent.name),
      state: "waiting_clarify",
      clarify: route.clarify,
    };
  }

  const { task, startNow } = tm.create({
    channel: msg.channel,
    chatId: msg.chatId,
    chatType: msg.chatType,
    ownerSenderId: msg.senderId,
    ownerSenderName: msg.senderName ?? "",
    agentName: agent.name,
    prompt: content,
    ...(afterTask ? { afterTask } : {}),
    ...(input.acceptance ? { acceptance: input.acceptance } : {}),
    ...(input.contract ? { contract: input.contract } : {}),
    ...(input.reviewer ? { reviewer: input.reviewer } : {}),
  });
  if (input.brief) tm.update(msg.chatId, task.id, { brief: input.brief });
  publishCreated(task);

  if (startNow) {
    void runWorker(task, workerPrompt(task));
    return {
      taskId: task.id,
      agentName: agent.name,
      displayName: employeeDisplayName(agent.name),
      state: "running",
    };
  }
  // 等前置和等员工是两件事，文案不能混（见 DispatchOutcome.state 的注释）
  if (afterTask) {
    return {
      taskId: task.id,
      agentName: agent.name,
      displayName: employeeDisplayName(agent.name),
      state: "waiting_dep",
      afterTask,
    };
  }
  const busyWith = tm.occupyingTasks(msg.chatId, agent.name);
  const ahead = tm.queuedCount(msg.chatId, agent.name) - 1;
  return {
    taskId: task.id,
    agentName: agent.name,
    displayName: employeeDisplayName(agent.name),
    state: "queued",
    aheadCount: ahead > 0 ? ahead : 0,
    ...(busyWith.length > 0 ? { busyWithTaskIds: busyWith.map((t) => t.id) } : {}),
  };
}

/** 续派结果。redirected 说明发生了纠偏（本意续派，实际按回答/打断处理） */
export interface ContinueOutcome {
  taskId: string;
  agentName: string;
  displayName: string;
  state: "running" | "queued";
  redirected?: "answered_waiting" | "interrupted_running";
  resumedContext: boolean;
  aheadCount?: number;
}

/**
 * 该员工手上同时有多件活、而调用方没说续哪一件。
 *
 * 刻意**不**沿用「取最近活跃的那个」启发式：猜错的两种后果都很重且用户看不出发生了
 * 什么——要么打断了另一件正在跑的活，要么把用户的回答塞给了另一个问题。
 * 反问一次的成本远低于此。
 */
export interface ContinueAmbiguous {
  ambiguous: true;
  agentName: string;
  displayName: string;
  candidates: Array<{ taskId: string; state: TaskState; summary: string; question?: string }>;
}

export interface RetryOutcome {
  ok: boolean;
  taskId: string;
  state?: "running" | "queued";
  displayName?: string;
  resumedContext?: boolean;
  /** 本次重试前从归档复活了临时工（原临时工已被 TTL 清理） */
  revived?: boolean;
  reason?: "not_found_or_not_failed";
}

/** 失败任务原地重试：复用 taskId/session，session 丢失时用原始需求兜底。 */
export function opRetryTask(msg: ChannelMessage, taskId: string): RetryOutcome {
  const retried = tm.retryFailed(msg.chatId, taskId);
  if (!retried) return { ok: false, taskId, reason: "not_found_or_not_failed" };
  const { task, startNow } = retried;
  // 临时工可能已被 TTL sweep 释放归档（failed 是终态，不被当活跃任务）——
  // 派发前先从归档复活，否则 runWorker 拿不到 agent 会判「员工不存在」，
  // 这条失败任务就永久卡死无法重试。retryFailed 已把任务置回 queued/running（活跃态），
  // 复活后它不会再被同一轮 sweep 清走。
  let revived = false;
  if (!getAgent(task.agentName)) {
    revived = reviveTempWorker(task.agentName).ok;
  }
  const displayName = employeeDisplayName(task.agentName);
  const sameRuntimeSession = resumableSessionId(task, config.runtimeKind);
  const resumedContext = Boolean(sameRuntimeSession && loadSession(sameRuntimeSession));
  publishStateChange(task, "failed");
  if (startNow) {
    void runWorker(
      task,
      [
        "【用户要求重试失败任务】继续原任务。优先使用已保存的会话检查点；先核对已有工具结果和外部状态，避免重复写入。",
        "如果会话未能恢复，按下面的原始任务从头执行：",
        task.brief ?? task.prompt,
      ].join("\n\n"),
    );
  }
  return {
    ok: true,
    taskId: task.id,
    state: startNow ? "running" : "queued",
    displayName,
    resumedContext,
    revived,
  };
}

/**
 * 续派某员工近期工作（纯操作，不发消息）。
 * 保留旧路径的两处纠偏：员工正等用户回答 → 按回答处理；员工正在跑 → 打断后带新指示继续。
 */
export async function opContinueTask(input: {
  msg: ChannelMessage;
  agentName: string;
  content: string;
  candidates: BaseAgent[];
  /** 精确指定续哪个任务；员工手上有多件活时必须给，否则返回 ambiguous */
  taskId?: string;
}): Promise<ContinueOutcome | ContinueAmbiguous | { invalidAgent: true }> {
  const { msg, content, candidates } = input;
  const agent = getAgent(input.agentName);
  /**
   * 临时工不在 candidates 里（`listRoutableAgents` 结构性排除），但**续派必须放行**：
   * 他攥着上一轮的会话，而候选校验一刀切的结果是 boss 只能重招一个——新会话、
   * 上一轮查到的数据全丢，等于把同样的活重查一遍（实测就这么烧过一轮 token）。
   * 只放行绑定在**本会话**的在岗临时工：跨会话调用他没有任何正当场景。
   */
  const liveTempHere =
    agent?.profile.temp?.chatId === msg.chatId && hiredProfileExists(agent.name);
  if (!agent || (!candidates.some((c) => c.name === agent.name) && !liveTempHere)) {
    return { invalidAgent: true };
  }
  const display = employeeDisplayName(agent.name);
  const busy = tm.occupyingTasks(msg.chatId, agent.name);

  // 指定了任务号就照办；没指定且他手上不止一件活 → 不猜，反问
  let occupying: Task | undefined;
  if (input.taskId) {
    occupying = busy.find((t) => t.id === input.taskId);
    // 指定的任务号不在他名下的占用任务里：可能已经做完了，也可能是用户记错了。
    // 落到下面的「新建任务」分支，与不指定时一致——不要在这里报错，那会把
    // 「他刚做完、用户想接着改」这个最常见的续派场景判成失败。
  } else if (busy.length > 1) {
    return {
      ambiguous: true,
      agentName: agent.name,
      displayName: display,
      candidates: busy.map((t) => ({
        taskId: t.id,
        state: t.state,
        summary: truncate(t.prompt, 80),
        ...(t.question ? { question: truncate(t.question, 150) } : {}),
      })),
    };
  } else {
    occupying = busy[0];
  }

  // 该员工正卡在 waiting_user：「延续其工作」的消息实际就是在回答那个待确认问题
  if (occupying?.state === "waiting_user") {
    const prev = occupying.state;
    tm.markRunning(msg.chatId, occupying.id);
    publishStateChange(occupying, prev);
    void runWorker(occupying, answerPrompt(occupying.question, content), {
      restoreWaitingOnError: true,
    });
    return {
      taskId: occupying.id,
      agentName: agent.name,
      displayName: display,
      state: "running",
      redirected: "answered_waiting",
      resumedContext: true,
    };
  }

  // 中途插话：打断当前执行，在同一会话上带新指示继续
  if (occupying?.state === "running" && interruptRun(msg.chatId, occupying.id)) {
    void runWorker(
      occupying,
      `【用户打断了你正在进行的工作，带来新的指示，请按新指示调整后继续】\n${content}`,
    );
    return {
      taskId: occupying.id,
      agentName: agent.name,
      displayName: display,
      state: "running",
      redirected: "interrupted_running",
      resumedContext: true,
    };
  }

  // 明确指到了某个任务就续它的会话——这是并发岗位上唯一可靠的续派方式
  // （latestSessionOf 在并发岗位会返回 undefined，因为「最近活跃即用户所指」不再成立）。
  const named = input.taskId ? tm.get(msg.chatId, input.taskId) : undefined;
  const resumeSessionId =
    named?.agentName === agent.name && named.sessionId
      ? named.sessionId
      : tm.latestSessionOf(msg.chatId, agent.name);
  const { task, startNow } = tm.create({
    channel: msg.channel,
    chatId: msg.chatId,
    chatType: msg.chatType,
    ownerSenderId: msg.senderId,
    ownerSenderName: msg.senderName ?? "",
    agentName: agent.name,
    prompt: content,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  });
  publishCreated(task);
  if (startNow) {
    void runWorker(task, task.prompt);
    return {
      taskId: task.id,
      agentName: agent.name,
      displayName: display,
      state: "running",
      resumedContext: Boolean(resumeSessionId),
    };
  }
  return {
    taskId: task.id,
    agentName: agent.name,
    displayName: display,
    state: "queued",
    resumedContext: Boolean(resumeSessionId),
  };
}

/** 转达用户答复的结果 */
export type AnswerOutcome =
  | { ok: true; taskId: string; displayName: string; rerouted?: string }
  | { ok: false; reason: "not_found" | "not_waiting" }
  /** 澄清后仍无人可派：占位任务已取消，brief 是合并了答复的完整诉求（拿去招临时工） */
  | { ok: false; reason: "no_fit"; detail: string; brief: string; taskId: string };

/**
 * 用户答复该「重路由」还是「回到本任务原本的员工」。
 *
 * 只有澄清占位任务（从未派发过员工，等用户定向）才重路由——它的 agentName 只是路由器的
 * 初步猜测，答复合并进原诉求后要重新择人。其余任何 waiting_user 任务都已经有员工真跑过，
 * 答复必须回到那个员工。
 *
 * 曾经用 `!task.sessionId` 判占位，把 retro（子会话 persistSession:false、任务从不带
 * sessionId）的复盘任务误判成占位，答复被重路由到候选池里别的岗位（且池子排除了 manualOnly
 * 的 retro），于是复盘答复永远回不到复盘员、被甩给 hr。改用显式标记杜绝这类误判。
 */
export function shouldRerouteAnswer(task: Pick<Task, "awaitingClarifyRoute">): boolean {
  return task.awaitingClarifyRoute === true;
}

/**
 * 把用户的答复转给正在等待的员工（纯操作，不发消息）。
 * 澄清占位任务（awaitingClarifyRoute）：答复用于定向 → 合并原诉求重新路由后首次派发。
 */
export async function opAnswerEmployeeQuestion(input: {
  msg: ChannelMessage;
  taskId: string;
  content: string;
  candidates: BaseAgent[];
}): Promise<AnswerOutcome> {
  const { msg, content, candidates } = input;
  const task = tm.get(msg.chatId, input.taskId);
  if (!task) return { ok: false, reason: "not_found" };
  if (task.state !== "waiting_user") return { ok: false, reason: "not_waiting" };

  const prev = task.state;
  if (shouldRerouteAnswer(task)) {
    const combined = `${task.prompt}\n\n（用户补充澄清：${content}）`;
    const routed = await routeAgent(combined, candidates);
    if (routed.via === "none") {
      // 这个任务从未跑过（澄清占位），只是等用户定向的承接人。留着它只会永远挂在
      // waiting_user，而活得换条路走 → 就地取消，把合并后的诉求交回上层去招临时工
      tm.cancel(msg.chatId, task.id);
      publishStateChange(task, prev);
      return { ok: false, reason: "no_fit", detail: routed.reason, brief: combined, taskId: task.id };
    }
    // 派发成功即清除占位标记：此后它是正常在办任务，再有提问时答复应回到它自己的员工。
    tm.update(msg.chatId, task.id, {
      agentName: routed.agent.name,
      prompt: combined,
      awaitingClarifyRoute: undefined,
    });
    tm.markRunning(msg.chatId, task.id);
    publishStateChange(task, prev);
    void runWorker(task, combined);
    return {
      ok: true,
      taskId: task.id,
      displayName: employeeDisplayName(routed.agent.name),
      rerouted: routed.agent.name,
    };
  }
  // 真跑过的任务（含无 sessionId 的 retro 复盘）：答复回到它自己的员工，绝不重路由。
  // 有 sessionId 则 runWorker 会 resume 续跑；无 sessionId（retro 子会话不落 session）则
  // 重新起一轮同一员工——工作始终留在原岗位，不会被甩给候选池里别的人（更不会落到 hr）。
  tm.markRunning(msg.chatId, task.id);
  publishStateChange(task, prev);
  void runWorker(task, answerPrompt(task.question, content), { restoreWaitingOnError: true });
  return { ok: true, taskId: task.id, displayName: employeeDisplayName(task.agentName) };
}

/**
 * 招一个临时工并把活交给他（纯操作，不发消息）。
 *
 * 放在 boss.ts 而不是 temp-worker.ts：交接要动 markRunning / publishStateChange /
 * runWorker，而 temp-worker.ts 必须不依赖 boss.ts（否则成环，见 inflight.ts 的说明）。
 */
export function opHireTempWorker(input: {
  msg: ChannelMessage;
  /** 能力域（不是这一次的活）：归纳聚类的键 */
  capability: string;
  description: string;
  systemPrompt: string;
  /** 交给他的活（也是 brief） */
  brief: string;
  /** 工具白名单；不给则只读。含高权限工具时 readRoots 必填（由 hireTempWorker 判） */
  tools?: string[];
  readRoots?: string[];
  /** 按这件活的实际规模给的步数额度；不给则由 hireTempWorker 按权限取缺省 */
  maxTurns?: number;
}):
  | { ok: true; taskId: string; agentName: string; displayName: string; highPriv?: string }
  | { ok: false; reason: string } {
  const { msg } = input;
  // 先建任务再招人：临时工必须绑定到一个具体任务，没有任务的临时工没有存在意义
  const { task } = tm.create({
    channel: msg.channel,
    chatType: msg.chatType,
    chatId: msg.chatId,
    ownerSenderId: msg.senderId,
    ownerSenderName: msg.senderName ?? msg.senderId,
    // 先占位，招聘成功后改派给临时工；招聘失败则连任务一起取消
    agentName: DEFAULT_AGENT_NAME,
    prompt: input.brief,
  });

  const hired = hireTempWorker({
    capability: input.capability,
    hiredFor: input.brief,
    description: input.description,
    systemPrompt: input.systemPrompt,
    hiredBy: "boss",
    taskId: task.id,
    chatId: msg.chatId,
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.readRoots?.length ? { readRoots: input.readRoots } : {}),
    ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
  });
  if (!hired.ok) {
    tm.cancel(msg.chatId, task.id);
    return { ok: false, reason: hired.reason };
  }

  const prev = task.state;
  // brief 快照留在 Task 上：崩溃恢复不该依赖 profile 文件还在
  tm.update(msg.chatId, task.id, { agentName: hired.id, brief: input.brief });
  tm.markRunning(msg.chatId, task.id);
  const bound = tm.get(msg.chatId, task.id) ?? task;
  publishStateChange(bound, prev);
  void runWorker(bound, input.brief);
  const highPriv = (getAgent(hired.id)?.profile.tools ?? []).filter(isHighPrivTool);
  return {
    ok: true,
    taskId: task.id,
    agentName: hired.id,
    displayName: hired.displayName,
    ...(highPriv.length > 0 ? { highPriv: highPriv.join(" / ") } : {}),
  };
}

/** 取消任务（纯操作，不发消息）。同时记一条负反馈——主动取消比嘴上说的更硬 */
export function opCancelTask(
  msg: ChannelMessage,
  taskId: string,
): { ok: true; taskId: string } | { ok: false } {
  const target = tm.get(msg.chatId, taskId);
  const prev = target?.state;
  // 先打断在跑的 run：只改 store 状态的话执行方会一路跑完、完成回调照样触发，
  // 「已取消」就成了假话
  if (prev === "running") interruptRun(msg.chatId, taskId);
  const cancelled = tm.cancel(msg.chatId, taskId);
  if (!cancelled) return { ok: false };
  if (prev) publishStateChange(cancelled, prev);
  recordFeedback(msg, "cancel", "negative", cancelled);
  advanceEmployee(msg.chatId, cancelled.agentName);
  return { ok: true, taskId: cancelled.id };
}

/**
 * 定时任务派发入口（调度器调用）：完全复用 boss 主干——任务进队列、受并发闸门约束、
 * 走验收与 leader 汇报、Dashboard 可见、可 /cancel。
 *
 * 返回：
 * - dispatched：已派发（running）或已入队（queued）
 * - skipped：员工繁忙且策略为 skip，本次跳过
 * - missing：员工不存在（调用方应停用该 schedule）
 */
export function dispatchScheduledTask(input: {
  scheduleId: string;
  title: string;
  agentName: string;
  prompt: string;
  brief?: string;
  channel: string;
  chatId: string;
  chatType: "private" | "group";
  ownerSenderId: string;
  ownerSenderName: string;
}): { status: "dispatched" | "missing"; taskId?: string; queued?: boolean } {
  const agent = getAgent(input.agentName);
  if (!agent) return { status: "missing" };

  // 定时任务每次都是全新会话，不会与用户的对话串上下文 → 默认直接并行执行，
  // 不因「该员工正在陪用户聊天」而跳过。唯一需要串行的是「共享工作目录 + 有写能力」
  // 的岗位（两个 run 同时改同一个 clone 会踩踏），这类走队列排队。
  const forceStart = !agent.needsSerialRun();

  const { task, startNow } = tm.create({
    channel: input.channel,
    chatId: input.chatId,
    chatType: input.chatType,
    ownerSenderId: input.ownerSenderId,
    ownerSenderName: input.ownerSenderName,
    agentName: input.agentName,
    prompt: input.prompt,
    forceStart,
  });
  // scheduled 标记：结论照旧投递到用户会话、看板照旧可见，但不进 boss 的「最近收尾」快照
  // —— 否则每天都跑的复盘会把槽位占满，把用户自己的任务挤出视野（见 Task.scheduled）
  tm.update(input.chatId, task.id, {
    scheduled: true,
    ...(input.brief ? { brief: input.brief } : {}),
  });
  publishCreated(task);

  const who = employeeDisplayName(input.agentName);
  if (startNow) {
    say(
      task,
      `⏰ 定时任务「${input.title}」到点了，交给「${who}」（任务 #${task.id}）…` + taskLink(task),
    );
    void runWorker(task, workerPrompt(task), { scheduled: true });
    return { status: "dispatched", taskId: task.id };
  }
  // 仅共享工作目录的岗位会走到这里：排队等目录空出来，避免并行踩踏同一个 clone
  say(
    task,
    `⏰ 定时任务「${input.title}」到点了，「${who}」的工作目录正被占用，已排队（任务 #${task.id}）。` +
      taskLink(task),
  );
  return { status: "dispatched", taskId: task.id, queued: true };
}

/** 定时任务的后继（线性 then）：上一个跑完后接着派一个 */
export function dispatchFollowUp(input: {
  agentName: string;
  prompt: string;
  channel: string;
  chatId: string;
  chatType: "private" | "group";
  ownerSenderId: string;
  ownerSenderName: string;
}): void {
  const agent = getAgent(input.agentName);
  if (!agent) {
    console.warn(`[schedule] 后继任务的员工「${input.agentName}」不存在，跳过`);
    return;
  }
  const { task, startNow } = tm.create({
    channel: input.channel,
    chatId: input.chatId,
    chatType: input.chatType,
    ownerSenderId: input.ownerSenderId,
    ownerSenderName: input.ownerSenderName,
    agentName: input.agentName,
    prompt: input.prompt,
  });
  publishCreated(task);
  say(
    task,
    `↪️ 接续任务：交给「${employeeDisplayName(input.agentName)}」（任务 #${task.id}）…` +
      taskLink(task),
  );
  if (startNow) void runWorker(task, workerPrompt(task), { scheduled: true });
}

/**
 * 启动时恢复：把中断的 running 任务重新派发。
 * 超过重跑上限的任务已被判失败（见 store.MAX_RECOVERS）——那类任务要告知用户，
 * 否则它会静默消失（进程反复重启时同一任务被无限重跑正是这么被发现的）。
 */
export function bossRecover(): void {
  const { requeued, aborted } = recoverInterruptedTasks();
  for (const t of aborted) {
    publishStateChange(t, "running");
    say(
      t,
      `${mention(t)}⚠️ 任务 ${taskRef(t)} 已停止重试：${t.error ?? "反复中断"}\n` +
        `原始诉求：${truncate(t.prompt, 80)}\n如果还需要，重新发一次给我。`,
    );
  }
  for (const [chatId, tasks] of requeued) {
    for (const t of tasks) {
      // 逐员工出队一个即可（其余仍在 queued 等待）
      advanceEmployee(chatId, t.agentName);
    }
  }

  // 补触发等待中的后继：宕机期间前置可能已跑到终态，那次终态钩子随进程一起没了。
  recoverPendingHandoffs();

  // 被重启打断的 boss 对话轮次：它不是 Task，没有状态机兜底，不主动说一声就等于静默吞掉。
  // 刻意不自动重跑——那一轮可能已经调过 dispatch_task / cancel_task 这类有副作用的工具。
  for (const turn of sweepInterruptedTurns()) {
    void deliver(
      {
        channel: turn.channel,
        chatId: turn.chatId,
        chatType: turn.chatType,
        ownerSenderId: turn.ownerSenderId,
      },
      `⚠️ 服务刚重启过，你上一条「${truncate(turn.text, 40)}」我没答完。\n` +
        `我没有自动重试（怕把已经派出去的活重复派一遍）。还需要的话再发一次；` +
        `想先看看当时有没有派成，问我「现在在跑什么」。`,
    );
  }
}
