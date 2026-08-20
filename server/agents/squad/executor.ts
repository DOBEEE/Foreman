import { join } from "node:path";
import { config } from "../../config/index.js";
import { missingContractFiles, validateContract } from "../../core/contract.js";
import { getRuntime } from "../../runtime/index.js";
import type { AgentEvent, ProgressData } from "../../core/runner.js";
import { EphemeralAgent } from "./ephemeral.js";
import type { Escalation, StepContract, StepOutcome, TeamPlan, TeamStep } from "./types.js";
import {
  buildEscalateTool,
  buildRejectUpstreamTool,
  buildSubmitStepTool,
} from "../../runtime/tools/protocol-tools.js";
import {
  renderStepReport,
  SUBMIT_STEP_TOOL,
  type ReviewRecord,
  type StepReport,
} from "../../tools/step-report.js";

/** 委派嵌套上限：防组长互相委派失控 */
export const MAX_DEPTH = 2;

/**
 * 步骤瞬态错误的重试节奏（与 boss 主干 TRANSIENT_RETRY_DELAYS_MS 对齐）。
 * 编队步骤走 runDelegate 而非 boss 的 runWorker，早先没有这层——一次流式断连
 * （网关 idle 超时切断长连接，undici 抛 terminated）就把整步判失败、零产出，
 * 且执行器「跳过失败步继续」会把连环断连伪装成「整个 squad 一次性被 kill」。
 */
const STEP_TRANSIENT_RETRY_DELAYS_MS = [3_000, 8_000, 20_000] as const;

/** 步骤模板渲染上下文 */
export interface StepContextLite {
  input: string;
  params: Record<string, unknown>;
  conclusionOf: (id: string) => string | undefined;
  /** 取前序步骤合约提取的字段值 */
  fieldOf: (id: string, field: string) => string | undefined;
}

/** 渲染步骤模板：{{input}} / {{param.xxx}} / {{step:<id>}} / {{step:<id>.<field>}} */
export function renderStepTemplate(tpl: string, ctx: StepContextLite): string {
  return tpl
    .replace(/\{\{\s*input\s*\}\}/g, ctx.input)
    .replace(/\{\{\s*step:([\w-]+)\.([\w]+)\s*\}\}/g, (_m, id: string, field: string) => ctx.fieldOf(id, field) ?? "")
    .replace(/\{\{\s*step:([\w-]+)\s*\}\}/g, (_m, id: string) => ctx.conclusionOf(id) ?? "")
    .replace(/\{\{\s*param\.(\w+)\s*\}\}/g, (_m, k: string) => {
      const v = ctx.params[k];
      return v == null ? "" : String(v);
    });
}

/**
 * 当前在跑的步骤。
 *
 * 编队步骤走 runDelegate 直接跑 agent，**不建 boss Task**，所以看板从任务列表里
 * 永远看不到编队成员在忙。把「推进到哪一步」落进组长的断点状态文件，
 * 看板才有事实源可读（否则只能靠猜，猜的结果是连线整簇消失）。
 */
export interface RunningStep {
  stepId: string;
  /** 该步此刻在跑的人：执行阶段是 employee，评审阶段是 reviewer */
  employee: string;
  role: "exec" | "review";
  startedAt: number;
}

/** 编队执行环境：谁当组长、在哪个目录干、以什么身份委派 */
export interface SquadRuntime {
  /** 组长员工 id（employee="lead" 的步骤经 runLeadStep 回调执行） */
  leadName: string;
  /** 共享工作目录：全部步骤在此执行，产物跨步可见 */
  cwd: string;
  /** 透传给每次委派的基础 params（channel/chatId/taskId 等，taskId 仅作 trace 关联） */
  baseParams: Record<string, unknown>;
  /** 当前嵌套深度（boss 直派 = 0） */
  depth: number;
  abortController?: AbortController;
  /** employee="lead" 的自执行步回调（组长自己的会话跑一段），未提供则此类步骤报错 */
  runLeadStep?: (prompt: string, maxTurns?: number) => Promise<string>;
  /** 每步落定即回调（lead 持久化断点状态用） */
  onStepDone?: (outcome: StepOutcome) => void;
  /** 每次换人开工即回调（执行 / 评审各算一次）。清除由 onStepDone 负责 */
  onStepRunning?: (running: RunningStep) => void;
}

function progress(
  id: string,
  title: string,
  status: ProgressData["status"],
  meta?: Pick<ProgressData, "parentId" | "employee" | "index" | "total">,
): AgentEvent {
  return { event: "progress", data: { id, title, status, ...meta } };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…（产出过长已截断）` : s;
}

/**
 * 模型流中断这类**运行时抖动**（非模型判断错误）：长会话下 SDK 偶发
 * `AI_NoOutputGeneratedError`（流结束但没有 finish chunk）。这不是员工干得不对，
 * 重跑一次通常就好，不该让整步直接 failed。
 */
function isTransientStreamError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /NoOutputGenerated|without a finish chunk|stream (?:ended|closed|error)|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
    msg,
  );
}

/**
 * 进程内委派执行一段 brief，收集其文本产出（共享编队 cwd，注入编队协议）。
 * 增强：支持 session 持久化（用于 inter-step dialog resume）、额外协议工具注入，
 * 以及**瞬态错误自动重试**（网关断连 / 空响应，在原会话 resume 续跑）。
 *
 * 导出仅为回归夹具（check-squad-retry）注入假 agent 验证重试语义之用。
 */
interface DelegateResult {
  text: string;
  sessionId?: string;
}

export async function runDelegate(
  rt: SquadRuntime,
  agent: { run: (input: Record<string, unknown>) => AsyncGenerator<AgentEvent> },
  brief: string,
  squad: Record<string, unknown>,
  opts?: {
    extraTools?: Record<string, unknown>;
    resume?: string;
  },
): Promise<DelegateResult> {
  let resume = opts?.resume;

  // 瞬态错误在原会话 resume 续跑：网关切断长连接（terminated）/ 空响应这类抖动，
  // 重试一轮往往就过。非瞬态错误或重试用尽 → 抛出让步骤 catch 如实判失败（带真实原因），
  // 而不是把半截产出/空文本当成品交下去。
  for (let attempt = 0; ; attempt++) {
    const parts: string[] = [];
    let sessionId: string | undefined = resume;
    let errored: { message: string; retryable: boolean } | undefined;

    for await (const e of agent.run({
      prompt: brief,
      cwd: rt.cwd,
      persistSession: true,
      ...(resume ? { resume } : {}),
      ...(rt.abortController ? { abortController: rt.abortController } : {}),
      params: {
        ...rt.baseParams,
        __internal: true,
        __depth: rt.depth + 1,
        delegatedBy: rt.leadName,
        __squad: squad,
        ...(opts?.extraTools ? { __extraTools: opts.extraTools } : {}),
      },
    })) {
      if (e.event === "text") parts.push(e.data.text);
      if (e.event === "session") sessionId = e.data.sessionId as string;
      if (e.event === "result") {
        if (e.data.sessionId) sessionId = e.data.sessionId as string;
        if (e.data.isError) {
          errored = {
            message: (e.data.result as string) || "本轮执行出错",
            retryable: e.data.retryable === true,
          };
        }
      }
    }

    if (!errored) return { text: parts.join("").trim(), sessionId };

    // 用户主动打断：立刻停，不重试（与步骤 catch 的语义一致）
    if (rt.abortController?.signal.aborted) {
      throw new Error(errored.message);
    }

    const canRetry =
      errored.retryable && attempt < STEP_TRANSIENT_RETRY_DELAYS_MS.length;
    if (!canRetry) {
      throw new Error(
        attempt > 0
          ? `${errored.message}（已自动重试 ${attempt} 次仍未恢复）`
          : errored.message,
      );
    }

    const delayMs = STEP_TRANSIENT_RETRY_DELAYS_MS[attempt];
    console.warn(
      `[squad] 委派瞬态中断（${errored.message.slice(0, 80)}），` +
        `${Math.round(delayMs / 1000)}s 后在原会话 resume 重试（${attempt + 1}/${STEP_TRANSIENT_RETRY_DELAYS_MS.length}）`,
    );
    await new Promise((r) => setTimeout(r, delayMs));
    resume = sessionId ?? resume; // 有 sessionId 就续跑上轮检查点，否则从头再来
  }
}

/** 解析步骤执行者：注册员工 or 现场构造的临时工 */
async function resolveExecutor(
  step: TeamStep,
): Promise<{ run: (input: Record<string, unknown>) => AsyncGenerator<AgentEvent> }> {
  if (step.employee === "temp") {
    if (!step.temp?.role) throw new Error(`步骤 ${step.id} 指定临时工但缺 temp.role 规格`);
    return new EphemeralAgent(step.id, step.temp) as never;
  }
  const { getAgent } = await import("../registry.js");
  const employee = getAgent(step.employee);
  if (!employee) throw new Error(`编队成员不存在：${step.employee}`);
  return employee as never;
}

/** 按 id 取注册员工（评审人只能是正式员工） */
async function resolveEmployee(
  id: string,
): Promise<{ run: (input: Record<string, unknown>) => AsyncGenerator<AgentEvent> }> {
  const { getAgent } = await import("../registry.js");
  const employee = getAgent(id);
  if (!employee) throw new Error(`编队成员不存在：${id}`);
  return employee as never;
}

/** 轻量单轮 LLM（无工具）：验收兜底判定 / 评审结论解析 */
async function askLight(prompt: string, _cwd: string): Promise<string> {
  const result = await getRuntime().complete({
    prompt,
    model: config.routerModel ?? config.model,
    cwd: _cwd,
  });
  return result.text.trim();
}

interface Verdict {
  pass: boolean;
  feedback: string;
}

/**
 * 一个 `submit_step` 工具 + 读取其入参的闭包。
 *
 * 编队成员的产出通道从「整段流式文本」换成这个工具：早先 `output = parts.join("")`
 * 意味着组长收尾时读到的是「Now let me do targeted scans per package…」这种旁白，
 * 真结论在 2000 字截断处被切掉；`produces.data` 也只能拿这坨文本喂轻量 LLM 反向刮取。
 * 现在字段是员工**填**的，校验与落档都是确定性的。
 *
 * 导出仅为回归夹具（check-squad-submit）之用。
 */
export function submitSlot(opts?: { dataFields?: Record<string, string>; reviewer?: boolean }): {
  tool: unknown;
  get: () => StepReport | undefined;
} {
  let report: StepReport | undefined;
  const tool = buildSubmitStepTool((r) => {
    report = r;
    return opts?.reviewer
      ? "评审结论已提交给组长。本轮到此结束，不要再输出任何文本。"
      : "已交卷给组长。本轮到此结束，不要再输出任何文本。";
  }, opts);
  return { tool, get: () => report };
}

/** 只输出文本就结束 = 没交卷。同会话增量提醒，不让他把活重做一遍 */
export const SUBMIT_NUDGE = [
  `【本轮无效：你没有调用 ${SUBMIT_STEP_TOOL} 交卷】`,
  "正文里的文字组长和下游步骤都读不到——引擎只认这个工具的入参。",
  `你已经做过的工作不用重做，直接调 ${SUBMIT_STEP_TOOL} 把成果提交一次即可。`,
].join("\n");

/**
 * 侧支委派（评审 / 上游修补）：这两条路**没有外层重试循环**，所以未交卷时就地补一次提醒。
 * 主步骤不走这里——它的重试要计入 maxRetries，由主循环统一记账。
 *
 * 导出仅为回归夹具（check-squad-submit）之用。
 */
export async function runWithSubmit(
  rt: SquadRuntime,
  agent: { run: (input: Record<string, unknown>) => AsyncGenerator<AgentEvent> },
  brief: string,
  squad: Record<string, unknown>,
  slot: { tool: unknown; get: () => StepReport | undefined },
  opts?: { resume?: string; extraTools?: Record<string, unknown> },
): Promise<DelegateResult> {
  const extraTools = { ...(opts?.extraTools ?? {}), [SUBMIT_STEP_TOOL]: slot.tool };
  const first = await runDelegate(rt, agent, brief, squad, {
    extraTools,
    ...(opts?.resume ? { resume: opts.resume } : {}),
  });
  if (slot.get()) return first;
  console.warn(`[squad] 侧支委派未调用 ${SUBMIT_STEP_TOOL}，同会话提醒一次`);
  const retried = await runDelegate(rt, agent, SUBMIT_NUDGE, squad, {
    extraTools,
    ...(first.sessionId ? { resume: first.sessionId } : {}),
  });
  return { text: retried.text, sessionId: retried.sessionId ?? first.sessionId };
}

/** 无 reviewer、仅 accept 时的组长轻量验收（沿用原 SOP 语义） */
async function lightAccept(
  step: TeamStep,
  output: string,
  rt: SquadRuntime,
): Promise<Verdict> {
  try {
    const text = await askLight(
      [
        `你是组长「${rt.leadName}」，验收步骤「${step.title}」的产出。`,
        `验收标准：${step.accept}`,
        `产出：\n${truncate(output, 6000)}`,
        '只输出 JSON：{"pass":true|false,"feedback":"不达标时给出具体、可执行的修改意见"}',
      ].join("\n\n"),
      rt.cwd,
    );
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    const parsed = json ? (JSON.parse(json) as Partial<Verdict>) : undefined;
    return { pass: parsed?.pass !== false, feedback: parsed?.feedback ?? "" };
  } catch {
    return { pass: true, feedback: "" };
  }
}

/**
 * 产出合约校验：文件用 fs 硬查，数据字段直接取交卷入参的 `data`（员工填的，零模型调用）。
 * 实现在 `core/contract.ts`（boss 的任务级验收共用同一套）。
 */
async function validateStepContract(
  contract: StepContract,
  report: StepReport,
  output: string,
  cwd: string,
): Promise<{ pass: boolean; missing: string[]; extracted: Record<string, string> }> {
  return validateContract(contract, output, cwd, async () => report.data ?? {});
}

/** 评审人 brief：真跑一轮员工评审（可用工具在共享目录核实），结论走 submit_step 提交 */
function buildReviewBrief(plan: TeamPlan, step: TeamStep, output: string): string {
  return [
    `请评审编队步骤「${step.title}」（执行者：${step.employee}）的产出。`,
    `任务整体目标：${plan.goal}`,
    `本步验收标准：${step.accept ?? "按你的专业判断是否达到可交付质量"}`,
    `执行者交卷内容：\n${truncate(output, 8000)}`,
    "要求：产物在当前工作目录里，需要时用工具核实（读文件/跑检查），不要只看文字描述。",
    `评审结束后调 ${SUBMIT_STEP_TOOL} 提交结论：\`verdict\` 必填（pass / reject），` +
      "`conclusion` 写你的判定依据；reject 时必须给出具体、可执行的修改意见。" +
      "只把报告写在正文里不算提交——引擎只认这个工具的入参。",
  ].join("\n\n");
}

/**
 * 按 plan 顺序执行编队步骤（reviewer 循环内置）：
 *   执行者产出 → reviewer 员工真跑评审 → 不过 → 执行者带意见重做（≤ maxRetries）
 * 重做仍不过：步骤标注 ⚠️ 继续往后走，由组长在收尾汇报中如实披露（不抛异常打断编队）。
 * 返回全部 StepOutcome。单步异常记为 status=failed 后继续往后跑（只有用户打断才向上抛），
 * 未完成项由组长在收尾阶段依据引擎给出的确定性清单决定重新编队还是如实交卷。
 */
export async function* executeTeamPlan(
  rt: SquadRuntime,
  plan: TeamPlan,
  taskInput: { prompt: string; params?: Record<string, unknown> },
  /** 断点续跑：已完成的步骤结论（按 step id），命中则跳过 */
  completed?: Map<string, StepOutcome>,
): AsyncGenerator<AgentEvent, StepOutcome[]> {
  if (rt.depth + 1 > MAX_DEPTH) {
    throw new Error(`编队委派嵌套超过上限（${MAX_DEPTH}），已中止以防失控`);
  }
  const outcomes: StepOutcome[] = [];
  const ctx: StepContextLite = {
    input: taskInput.prompt,
    params: taskInput.params ?? {},
    // failed 上游的 conclusion 可能是抢救回来的真实产出，也可能只是一句 SDK 报错。
    // 早先无差别直接渲染，于是下游 brief 里出现「上游定位结论：No output generated...」
    // 这种把报错当事实源的荒谬指令（真实事故：任务 3537e7 的 fix 步）。加警示 + 交代怎么判。
    conclusionOf: (id) => {
      const up = outcomes.find((o) => o.id === id);
      if (!up) return undefined;
      if (up.status === "failed") {
        return [
          `【上游步骤「${up.title}」未正常完成，以下内容仅供参考、不保证可用】`,
          up.conclusion,
          "若它只是一句报错或明显不完整，就当上游没有产出：自己把这部分补上并在产出里说明是你独立做的；需要拍板的用 escalate 问组长。",
        ].join("\n");
      }
      return up.conclusion;
    },
    fieldOf: (id, field) => outcomes.find((o) => o.id === id)?.extractedData?.[field],
  };

  const total = plan.steps.length;
  /** 顶层步骤的结构化元信息（执行者 + 步序），本函数内四处 yield 共用 */
  const topMeta = (step: TeamStep, i: number) => ({
    employee: step.employee,
    index: i + 1,
    total,
  });

  for (const [i, step] of plan.steps.entries()) {
    const done = completed?.get(step.id);
    yield progress(step.id, step.title, done ? "done" : "pending", topMeta(step, i));
    if (done) outcomes.push(done);
  }

  for (const [i, step] of plan.steps.entries()) {
    if (completed?.has(step.id)) continue;
    yield progress(step.id, step.title, "running", topMeta(step, i));
    const startMs = Date.now();
    const rendered = renderStepTemplate(step.brief, ctx);
    const maxRetries = step.maxRetries ?? 2;
    /** 引擎侧重试原因（未交卷 / 合约缺失 / 评审打回），与评审落档分开 */
    const retryNotes: string[] = [];
    /** 每一轮评审的落档，通过的那次也记 */
    const reviews: ReviewRecord[] = [];
    /** 组长自执行步不经 runDelegate，拿不到注入的工具，豁免交卷 */
    const isLeadStep = step.employee === "lead";
    let brief = rendered;
    let output = "";
    let report: StepReport | undefined;
    let accepted = false;
    let attempts = 0;
    let stepSessionId: string | undefined;
    let contractOk = true;
    let extractedData: Record<string, string> | undefined;
    /** 本步员工提出的确认项（escalate），随 outcome 落盘交组长收尾表态 */
    const escalations: Escalation[] = [];
    const MAX_ESCALATIONS_PER_STEP = 3;
    // 「历史最好产出」：末次执行崩了也不能把之前干成的活丢掉（详见下方合约校验处注释）
    let bestOutput = "";
    let bestReport: StepReport | undefined;
    let bestHits = -1;
    let bestExtracted: Record<string, string> | undefined;
    let bestContractOk = true;
    let bestAttempt = 0;

    try {
      // ── 前置校验：needs 声明的上游是否真的可用（不阻塞，只告知）──
      if (step.needs?.length) {
        const unmet: string[] = [];
        for (const depId of step.needs) {
          const up = outcomes.find((o) => o.id === depId);
          if (!up) unmet.push(`「${depId}」未执行`);
          // failed 的步骤 contractFulfilled 是 undefined，只判合约会把硬失败整个放过去
          else if (up.status === "failed") unmet.push(`「${up.title}」执行失败、没有产出`);
          else if (up.submitted === false) unmet.push(`「${up.title}」未按协议交卷、没有可信产出`);
          else if (up.contractFulfilled === false) unmet.push(`「${up.title}」产出合约未满足`);
        }
        if (unmet.length > 0) {
          brief = [
            rendered,
            `【注意】上游存在问题：${unmet.join("、")}。`,
            "brief 里引用的上游结论/字段可能是空的或不可用——先核实你需要的上游产物是否真的在。",
            "上游只是产出不完整时，用 reject_upstream 向对应步骤要；上游整步失败（无产出）时不要等它，自己把这部分补上并在产出里说明。",
            "过程中需要拍板的事（改哪个包、要不要顺带修、方案取舍）用 escalate 问组长。",
          ].join("\n\n");
        }
      }

      while (attempts <= maxRetries) {
        attempts++;
        rt.onStepRunning?.({
          stepId: step.id,
          employee: step.employee,
          role: "exec",
          startedAt: Date.now(),
        });
        if (step.employee === "lead") {
          if (!rt.runLeadStep) throw new Error(`步骤 ${step.id} 指定组长自执行，但未提供 runLeadStep`);
          output = await rt.runLeadStep(brief, step.maxTurns);
        } else {
          // 构建 reject_upstream handler：闭包捕获 outcomes + 执行能力，实现 inter-step dialog
          const rejectCounts = new Map<string, number>();
          const MAX_REJECTS_PER_UPSTREAM = 1;
          const rejectTool = buildRejectUpstreamTool(async ({ stepId, reason }) => {
            const count = (rejectCounts.get(stepId) ?? 0) + 1;
            rejectCounts.set(stepId, count);
            if (count > MAX_REJECTS_PER_UPSTREAM) {
              return "已达对该上游步骤的反馈上限，请基于当前状态继续完成你的任务。";
            }
            const upstream = outcomes.find((o) => o.id === stepId);
            if (!upstream?.sessionId) {
              // 上游没 session（整步失败时就是这样）：不能只回一句「自行处理」把人推回去猜，
              // 这种事该组长拍板，降级成 escalate 的语义。
              return [
                `上游步骤「${stepId}」无法被唤醒（它没有留下可续跑的会话，通常是整步执行失败）。`,
                "不要等它：需要拍板的部分用 escalate 问组长，其余按你自己的判断补上并在产出里说明。",
              ].join("\n");
            }
            const upstreamStep = plan.steps.find((s) => s.id === stepId);
            if (!upstreamStep) return `上游步骤「${stepId}」不存在。`;
            // Resume upstream session with downstream's feedback
            const feedbackBrief = [
              `下游步骤「${step.title}」反馈了一个问题：`,
              reason,
              `\n请处理这个反馈——可以修复问题，也可以解释原因。`,
              `处理完照常调 ${SUBMIT_STEP_TOOL} 重新交卷（这会覆盖你本步的记录）。`,
            ].join("\n");
            const upAgent = await resolveExecutor(upstreamStep);
            const upSlot = submitSlot(
              upstreamStep.produces?.data ? { dataFields: upstreamStep.produces.data } : undefined,
            );
            const upResult = await runWithSubmit(rt, upAgent, feedbackBrief, {
              lead: rt.leadName,
              goal: plan.goal,
              stepId,
              stepTitle: `修补「${upstreamStep.title}」`,
              role: "worker",
            }, upSlot, { resume: upstream.sessionId });
            if (upResult.sessionId) upstream.sessionId = upResult.sessionId;
            upstream.attempts++;
            const upReport = upSlot.get();
            if (!upReport) {
              // 修补跑了但没交卷：上游记录保持原样（不能拿空正文顶掉原结论），如实告知下游
              upstream.submitted = false;
              return [
                `上游步骤「${stepId}」被唤醒处理了你的反馈，但没有按协议重新交卷，`,
                "所以它的记录仍是修补前那一版。别再等它：按你自己的判断补上，并在交卷时说明这一点。",
              ].join("\n");
            }
            upstream.report = upReport;
            upstream.conclusion = renderStepReport(upReport);
            upstream.submitted = true;
            if (upReport.data && Object.keys(upReport.data).length > 0) {
              upstream.extractedData = { ...upstream.extractedData, ...upReport.data };
            }
            return upstream.conclusion;
          });

          const escalateTool = buildEscalateTool(async ({ question, options, blocking }) => {
            if (escalations.length >= MAX_ESCALATIONS_PER_STEP) {
              return "本步确认次数已达上限，请按你的最佳判断继续，并把剩余疑问写进产出。";
            }
            const record: Escalation = {
              stepId: step.id,
              question,
              ...(options?.length ? { options } : {}),
              blocking: blocking === true,
            };
            escalations.push(record);
            // 非阻塞：只登记，收尾阶段组长必须逐条表态（wrapup prompt 会把清单摆出来）
            if (!record.blocking) {
              return "已登记，组长会在收尾阶段表态。你先按最佳判断继续，并在产出里写明你采用的假设。";
            }
            // 阻塞：当场找组长要答复。组长跑不了（没接 runLeadStep）就退化成登记，
            // 绝不能把员工挂在这儿等一个永远不来的回答。
            if (!rt.runLeadStep) {
              record.blocking = false;
              return "组长当前无法即时作答，已登记为待表态项。请按最佳判断继续，并在产出里写明假设与风险。";
            }
            const answer = await rt.runLeadStep(
              [
                `【编队内确认请求】步骤「${step.title}」(${step.id}) 的执行者 ${step.employee} 需要你拍板：`,
                question,
                options?.length ? `他给的候选：\n${options.map((o) => `- ${o}`).join("\n")}` : "",
                `任务目标：${plan.goal}`,
                "产物就在当前工作目录，需要时用 Read/Bash 核实再答。",
                "请直接给结论（选哪个 / 怎么做 / 边界在哪），一段话说清即可，不要重新编队、不要交卷。",
                "你自己也定不了的，就说明「需要老板拍板」并给出在拿到答复前的临时处理建议——收尾阶段你要把它上抛。",
              ]
                .filter(Boolean)
                .join("\n\n"),
              8,
            );
            record.leadAnswer = answer;
            return answer || "组长未给出明确答复，请按最佳判断继续并在产出里写明假设。";
          });

          const stepSlot = submitSlot(
            step.produces?.data ? { dataFields: step.produces.data } : undefined,
          );
          try {
            const result = await runDelegate(rt, await resolveExecutor(step), brief, {
              lead: rt.leadName,
              goal: plan.goal,
              stepId: step.id,
              stepTitle: step.title,
              accept: step.accept,
              role: "worker",
            }, {
              extraTools: {
                reject_upstream: rejectTool,
                escalate: escalateTool,
                [SUBMIT_STEP_TOOL]: stepSlot.tool,
              },
              ...(stepSessionId ? { resume: stepSessionId } : {}),
            });
            stepSessionId = result.sessionId;
            report = stepSlot.get();
          } catch (error) {
            // 模型流抖动不是「员工干得不对」：换一次重试机会，会话还能续上就接着跑
            if (isTransientStreamError(error) && attempts <= maxRetries) {
              console.warn(`[squad] 步骤 ${step.id} 第 ${attempts} 次执行流中断，重试:`, error);
              brief = stepSessionId
                ? `上一轮执行被流中断打断了。请从中断处继续，做完调 ${SUBMIT_STEP_TOOL} 交卷。`
                : brief;
              continue;
            }
            // 已经有过成功产出：拿最好的那一版收尾，别让抖动把活干过的痕迹全抹掉
            if (bestOutput) {
              console.warn(`[squad] 步骤 ${step.id} 末次执行异常，采用此前最好产出:`, error);
              output = bestOutput;
              report = bestReport;
              contractOk = bestContractOk;
              extractedData = bestExtracted;
              retryNotes.push(
                `末次执行异常（${error instanceof Error ? error.message : String(error)}），已采用第 ${bestAttempt} 次的产出`,
              );
              break;
            }
            throw error;
          }

          // ── 交卷校验：只输出文本不算交卷（与员工对老板的纪律一致，不拿正文兜底）──
          if (!report) {
            if (attempts <= maxRetries) {
              retryNotes.push(`未按协议调用 ${SUBMIT_STEP_TOOL} 交卷（第 ${attempts} 次）`);
              brief = stepSessionId ? SUBMIT_NUDGE : `${rendered}\n\n${SUBMIT_NUDGE}`;
              continue;
            }
            // 重试用尽仍不交卷：没有可信产出，别把旁白当成品交给下游（组长收尾会看到这一条）
            console.warn(`[squad] 步骤 ${step.id} 经 ${attempts} 次仍未交卷，判未完成`);
            break;
          }
          output = renderStepReport(report);
        }

        // ── 产出合约校验（先于评审：东西没产出就不必评质量）──
        if (step.produces) {
          // 组长自执行步没有交卷入参，data 那一半无从校验，但文件那一半仍是 fs 一次调用的事
          const contract = report
            ? await validateStepContract(step.produces, report, output, rt.cwd)
            : (() => {
                const missing = missingContractFiles(step.produces, rt.cwd);
                return { pass: missing.length === 0, missing, extracted: {} };
              })();
          contractOk = contract.pass;
          extractedData = contract.extracted;
          // 留住「历史最好的一版」：字段命中最多的那次。文件那一半仍可能因门禁/路径出入判缺，
          // 一旦后续重试崩掉，这份产出就是下游唯一的救命稻草。
          const hit = Object.keys(contract.extracted).length;
          if (output && (contract.pass || hit > bestHits)) {
            bestOutput = output;
            bestReport = report;
            bestHits = hit;
            bestExtracted = contract.extracted;
            bestContractOk = contract.pass;
            bestAttempt = attempts;
          }
          if (!contract.pass && attempts <= maxRetries) {
            retryNotes.push(`产出合约未满足：${contract.missing.join("；")}`);
            // 有 session 就只发增量（下一轮 runDelegate 会 resume）：整段 brief 重发等于
            // 让员工从零把 15 分钟的活重做一遍，而他只是漏了两个字段。
            brief = stepSessionId
              ? [
                  `【产出合约未满足（第 ${attempts} 次）】以下产物缺失：`,
                  contract.missing.map((m) => `- ${m}`).join("\n"),
                  `你已经做过的工作不用重做，只把缺的这些补出来，然后重新调 ${SUBMIT_STEP_TOOL} 交卷。`,
                ].join("\n\n")
              : [
                  rendered,
                  `【产出合约未满足（第 ${attempts} 次）】以下产物缺失：`,
                  contract.missing.map((m) => `- ${m}`).join("\n"),
                  `请补齐这些产物后重新调 ${SUBMIT_STEP_TOOL} 交卷。`,
                ].join("\n\n");
            continue; // 跳过评审，直接重试
          }
        } else if (output) {
          bestOutput = output;
          bestReport = report;
          bestAttempt = attempts;
        }

        let verdict: Verdict = { pass: true, feedback: "" };
        if (step.reviewer) {
          rt.onStepRunning?.({
            stepId: step.id,
            employee: step.reviewer,
            role: "review",
            startedAt: Date.now(),
          });
          yield progress(`${step.id}#review`, "评审", "running", {
            parentId: step.id,
            employee: step.reviewer,
          });
          const reviewSlot = submitSlot({ reviewer: true });
          await runWithSubmit(
            rt,
            await resolveEmployee(step.reviewer),
            buildReviewBrief(plan, step, output),
            {
              lead: rt.leadName,
              goal: plan.goal,
              stepId: step.id,
              stepTitle: `评审「${step.title}」`,
              role: "reviewer",
            },
            reviewSlot,
          );
          const reviewReport = reviewSlot.get();
          // 拿不到 verdict 就是 inconclusive，**不按通过放行**——早先「解析失败按通过处理」
          // 这条兜底会让评审人少写一行 JSON 就静默放过一整步。但也别让评审人的失职
          // 变成执行者重做：记为未获有效评审，交组长在收尾裁决。
          const kind: ReviewRecord["verdict"] =
            reviewReport?.verdict === "pass"
              ? "pass"
              : reviewReport?.verdict === "reject"
                ? "reject"
                : "inconclusive";
          reviews.push({
            reviewer: step.reviewer,
            verdict: kind,
            attempt: attempts,
            ...(reviewReport?.conclusion ? { conclusion: reviewReport.conclusion } : {}),
            ...(kind === "inconclusive"
              ? { feedback: `评审人未按协议提交 ${SUBMIT_STEP_TOOL} 结论（已提醒一次）` }
              : kind === "reject"
                ? { feedback: reviewReport?.conclusion ?? "（评审未给出具体意见）" }
                : {}),
          });
          verdict =
            kind === "reject"
              ? { pass: false, feedback: reviewReport?.conclusion ?? "（评审未给出具体意见）" }
              : { pass: true, feedback: "" };
          yield progress(
            `${step.id}#review`,
            kind === "pass" ? "评审通过" : kind === "reject" ? "评审未过" : "评审无结论",
            kind === "pass" ? "done" : "failed",
            { parentId: step.id, employee: step.reviewer },
          );
        } else if (step.accept) {
          verdict = await lightAccept(step, output, rt);
        }

        if (verdict.pass) {
          accepted = true;
          break;
        }
        retryNotes.push(`评审打回：${verdict.feedback || "（评审未给出具体意见）"}`);
        brief = stepSessionId
          ? `【上一版未通过评审（第 ${attempts} 次）】意见：${verdict.feedback}\n请针对性修正后重做，改完调 ${SUBMIT_STEP_TOOL} 重新交卷。`
          : `${rendered}\n\n【上一版未通过评审（第 ${attempts} 次）】意见：${verdict.feedback}\n请针对性修正后重做，改完调 ${SUBMIT_STEP_TOOL} 重新交卷。`;
      }

      /** 员工没按协议交卷 = 本步没有可信产出。组长自执行步豁免（拿不到注入的工具） */
      const missingSubmit = !isLeadStep && !report;
      const outcome: StepOutcome = {
        id: step.id,
        title: step.title,
        employee: step.employee,
        status: "done",
        conclusion: missingSubmit
          ? `⚠️ 经 ${attempts} 次执行仍未按协议调用 ${SUBMIT_STEP_TOOL} 交卷，本步没有可信产出（正文旁白不作为产出，已按未完成对待）。`
          : !contractOk
            ? `⚠️ 经 ${attempts} 次执行产出合约仍未满足（${retryNotes.at(-1)}）\n最后交卷内容：\n${output}`
            : accepted
              ? output
              : `⚠️ 经 ${attempts} 次执行仍未通过评审，最后一次意见：${retryNotes.at(-1)}\n最后交卷内容：\n${output}`,
        attempts,
        ...(retryNotes.length ? { retryNotes } : {}),
        ...(stepSessionId ? { sessionId: stepSessionId } : {}),
        ...(report ? { report } : {}),
        ...(isLeadStep ? {} : { submitted: !missingSubmit }),
        ...(reviews.length ? { reviews } : {}),
        ...(extractedData && Object.keys(extractedData).length ? { extractedData } : {}),
        ...(step.produces ? { contractFulfilled: contractOk && !missingSubmit } : {}),
        ...(escalations.length ? { escalations } : {}),
        durationMs: Date.now() - startMs,
      };
      outcomes.push(outcome);
      rt.onStepDone?.(outcome);
      yield progress(
        step.id,
        step.title,
        accepted && contractOk && !missingSubmit ? "done" : "failed",
        topMeta(step, i),
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // 有过成功产出就绝不能让报错信息把它顶掉：早先这里无条件写 error.message，
      // 于是下游 {{step:id}} 拿到的"上游结论"变成一句 SDK 报错，还得自己把活重做一遍
      // （真实事故：任务 3537e7 —— diagnose 第一次的完整定位结论就这么消失了）。
      const outcome: StepOutcome = {
        id: step.id,
        title: step.title,
        employee: step.employee,
        status: "failed",
        conclusion: bestOutput
          ? `⚠️ 末次执行异常（${errMsg}），以下是第 ${bestAttempt} 次执行的产出（未走完验收，按未完成对待）：\n${bestOutput}`
          : errMsg,
        attempts,
        ...(retryNotes.length ? { retryNotes } : {}),
        ...(stepSessionId ? { sessionId: stepSessionId } : {}),
        ...(bestReport ? { report: bestReport } : {}),
        ...(reviews.length ? { reviews } : {}),
        ...(bestExtracted && Object.keys(bestExtracted).length ? { extractedData: bestExtracted } : {}),
        ...(escalations.length ? { escalations } : {}),
        durationMs: Date.now() - startMs,
      };
      outcomes.push(outcome);
      rt.onStepDone?.(outcome);
      yield progress(step.id, step.title, "failed", topMeta(step, i));
      // 用户打断必须立刻停；其余单步异常只让这一步 failed，**后续步骤照跑**。
      // 早先这里无条件 rethrow，一个步骤的结构错误就把整个编队砍掉（真实事故：
      // 任务 3b3385 的 clone 步缺 temp.role，后面 replace/CR/verify 三步一次没跑）。
      if (rt.abortController?.signal.aborted) throw error;
      console.warn(`[squad] 步骤 ${step.id} 异常，跳过继续:`, error);
    }
  }
  return outcomes;
}
