import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentOptions } from "../../types/agent-options.js";
import { config } from "../../config/index.js";
import { executeTeamPlan, type RunningStep, type SquadRuntime } from "../squad/executor.js";
import type { StepOutcome, TeamPlan } from "../squad/types.js";
import { buildSubmitPlanTool } from "../../runtime/tools/protocol-tools.js";
import { taskManager as tm } from "../../boss/task-manager.js";
import { type AgentEvent, type RunInput } from "../../core/runner.js";
import { BaseAgent } from "../base-agent.js";
import { listRoutableAgents } from "../registry.js";
import { ASK_USER_TOOL } from "../../tools/ask-user.js";
import { validateTeamPlan } from "../../tools/team-plan.js";
import { REPORT_DONE_TOOL } from "../../tools/task-report.js";
import { SUBMIT_STEP_TOOL } from "../../tools/step-report.js";

/** SOP 手册：出厂预置播种到用户目录，用户可改可删（删了则组长仅靠自身判断编队） */
function loadSopPlaybook(): string {
  const file = join(config.runtimeDir, "team-sop.md");
  try {
    return readFileSync(file, "utf-8").trim();
  } catch {
    return `（未找到编队 SOP 手册 ${file}，本次仅依据你自己的判断与岗位经验编队）`;
  }
}

/** 编队断点状态：跨轮（提问→用户回答）续跑，落盘在 <用户目录>/squads/<taskId>.json */
interface SquadState {
  plan: TeamPlan;
  outcomes: StepOutcome[];
  phase: "executing" | "wrapup";
  /** 已用的重新编队次数（组长收尾时发现没干完 → 重提 plan） */
  replans?: number;
  /** 历史轮次的步骤结论：重新编队会清空 outcomes，历史留在这里供收尾汇报 */
  history?: StepOutcome[];
  /**
   * 当前在跑的步骤。看板判断「这个编队是否真在推进」的唯一事实源 ——
   * 编队步骤不建 boss Task，任务列表里看不到成员在忙。
   * 进程被打断时这个字段会残留，所以读它的一方必须再校验组长任务本身是否还在 running。
   */
  running?: RunningStep;
}

/**
 * 重新编队次数上限。组长在收尾阶段可以推翻自己重编一次队（真实场景：首轮 plan 有结构错误
 * 或选人不当），但不能无限循环——用尽后强制按现状交卷。
 */
const MAX_REPLANS = 2;

const squadsDir = (): string => join(config.runtimeDir, "squads");

function statePath(taskId: string): string {
  return join(squadsDir(), `${taskId.replace(/[^\w-]/g, "_")}.json`);
}

function loadState(taskId: string): SquadState | undefined {
  try {
    const p = statePath(taskId);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf-8")) as SquadState;
  } catch {
    return undefined;
  }
}

function saveState(taskId: string, state: SquadState): void {
  try {
    mkdirSync(squadsDir(), { recursive: true });
    writeFileSync(statePath(taskId), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  } catch (error) {
    console.warn("[lead] 编队状态落盘失败（不影响本次执行）:", error);
  }
}

function clearState(taskId: string): void {
  rmSync(statePath(taskId), { force: true });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…（已截断，完整产物见工作目录）` : s;
}

/**
 * 编队组长（lead）：boss 判定任务需要多员工协作时派给他。四阶段：
 *   澄清（ask_user）→ 定 plan（submit_plan 工具）→ 执行（编队执行器）→ 收尾复核交卷
 *
 * 设计要点：
 * - **无状态可多开**：组长不持有个人持久状态，编队断点按 taskId 落盘、步骤串行执行、
 *   子步骤跑在编队共享目录 —— 不同任务并发互不影响。这条能力现在**在配置里真的声明了**
 *   （`workspacePolicy: "per-task"` + `maxParallel`），不再只是设计意图：
 *   同会话内可同时带几个编队，排队语义复用 boss 的员工并发槽，不另设队列。
 * - **首尾都是组长**：收尾是系统强制追加的一次**真员工 run**（带工具、在共享目录），
 *   组长可实检产物，再按模板 report_task_done 交卷——boss 侧零改动。
 * - **断点续跑**：plan 与已完成步骤落盘，用户回答问题后不重跑已完成的步骤。
 */
export class LeadAgent extends BaseAgent {
  readonly name = "lead";

  // 工作目录按任务分桶：走配置的 `workspacePolicy: "per-task"`，不再自己覆写 resolveRunCwd。
  // 曾经这里有一份自己的实现（<workspacesRoot>/lead/<taskId>），语义与基类等价但布局不同，
  // 而 per-task 目录清理器只认基类那套（<chat 桶>/task-<id>）—— 两套并存的结果是
  // lead 的目录被静默漏掉、永不回收。声明式的好处正是这个：只有一处定义分桶规则。

  /**
   * 挂载 submit_plan 协议工具（编队计划提交）。
   *
   * handler 必须真跑 validateTeamPlan：非法 plan 要当场把错误还给组长让他改。
   * 早先这里无条件回「已接收」，导致 `employee:"temp"` 缺 temp.role 这类错误一路带到
   * 执行期才抛异常（真实事故：任务 3b3385 的 clone 步炸掉、后续三步全没跑）。
   */
  override buildOptions(input: RunInput): AgentOptions & { protocolTools?: Record<string, unknown> } {
    const opts = super.buildOptions(input);
    const pt = (opts as Record<string, unknown>).protocolTools as Record<string, unknown> ?? {};
    pt.submit_plan = buildSubmitPlanTool(async (plan) => {
      const errs = await validateTeamPlan(plan as TeamPlan, this.name);
      if (errs.length > 0) {
        return [
          "编队计划**未通过校验，尚未开始执行**。请修正以下问题后重新调用 submit_plan：",
          ...errs.map((e) => `- ${e}`),
        ].join("\n");
      }
      return "编队计划已接收，系统开始按步骤执行。";
    });
    (opts as Record<string, unknown>).protocolTools = pt;
    return opts;
  }

  /** 花名册 + 忙闲：给组长选人用（{{roster}}） */
  protected buildTemplateParams(input: RunInput): Record<string, unknown> {
    const load = new Map<string, { running: number; queued: number; waiting: number }>();
    for (const t of tm.allActiveTasks()) {
      const cur = load.get(t.agentName) ?? { running: 0, queued: 0, waiting: 0 };
      if (t.state === "running") cur.running++;
      else if (t.state === "queued") cur.queued++;
      else if (t.state === "waiting_user") cur.waiting++;
      load.set(t.agentName, cur);
    }
    const roster = listRoutableAgents()
      .filter((a) => a.name !== this.name)
      .map((a) => {
        const l = load.get(a.name);
        // 影分身：不能再用「有 running/queued 就算忙」判——开了分身的同事占了一个位子
        // 仍有空位，那样判会让组长误以为他没空、白白避开或串起来排。
        const clones = a.profile.maxParallel ?? 1;
        const occupied = (l?.running ?? 0) + (l?.waiting ?? 0);
        return {
          id: a.name,
          displayName: a.displayName,
          routeHint: a.routeHint ?? a.description,
          tools: a.profile.tools ?? "（全部工具）",
          ...(clones > 1 ? { clones, freeClones: Math.max(0, clones - occupied) } : {}),
          busy: occupied >= clones,
          ...(l ? { load: l } : {}),
        };
      });
    return {
      ...super.buildTemplateParams(input),
      roster: JSON.stringify(roster, null, 2),
      sopPlaybook: loadSopPlaybook(),
    };
  }

  /**
   * 单轮步骤记录渲染。
   *
   * 评审必须显式成行——**包括通过的那次**。早先只在有「未通过意见」时才渲染一行
   * 「评审记录（N 次未通过）」，于是「评审通过」和「压根没配评审人」在组长眼里完全同形：
   * 真实事故里 code-review 跑完给了 pass，组长却在收尾记录里看不到一个字，只能判
   * 「这次修复从未经过 code-review」，又重新编队补跑一遍。
   * 同理，产出合约缺失不能再挤进「评审记录」那一行——两个关卡分开渲染。
   */
  private renderOutcomes(outcomes: StepOutcome[]): string {
    return outcomes
      .map((o) => {
        const lines: string[] = [];
        for (const r of o.reviews ?? []) {
          const mark =
            r.verdict === "pass" ? "✅ 评审通过" : r.verdict === "reject" ? "❌ 评审未过" : "⚠️ 评审无结论";
          lines.push(
            `  ${mark}（评审人 ${r.reviewer}，第 ${r.attempt} 次执行后）` +
              (r.feedback ? `：${truncate(r.feedback, 300)}` : ""),
          );
        }
        if (!o.reviews?.length) {
          // 没有评审记录就明说，别让组长自己去猜是「没配评审人」还是「评审丢了」
          lines.push("  （本步未配评审人，无评审记录）");
        }
        if (o.submitted === false) {
          lines.push(`  ⚠️ 未按协议交卷（${SUBMIT_STEP_TOOL} 未被调用），本步没有可信产出`);
        }
        if (o.contractFulfilled === false) lines.push("  ⚠️ 产出合约未满足");
        if (o.retryNotes?.length) {
          lines.push(`  重试记录（${o.retryNotes.length} 次）：${o.retryNotes.join(" | ")}`);
        }
        const head = `### [${o.id}] ${o.title} —— 执行者 ${o.employee}（${o.status}，执行 ${o.attempts} 次）`;
        return [head, ...lines, truncate(o.conclusion, 2000)].join("\n");
      })
      .join("\n\n");
  }

  /**
   * 收尾复核 brief：把执行记录交回组长，要求实检后按模板交卷。
   *
   * 必须显式列出**未完成的步骤**并给出「重新编队」这条出路——组长看得见硬失败才不会
   * 把半成品报成 done；而 canReplan 时告知新 plan 会被真执行，避免它以为提了也白提。
   */
  private buildWrapUpPrompt(
    plan: TeamPlan,
    outcomes: StepOutcome[],
    history: StepOutcome[],
    canReplan: boolean,
  ): string {
    /** 未完成的判定必须确定性：执行失败 / 未交卷 / 合约未满足 / 末轮评审没通过 */
    const incompleteReason = (o: StepOutcome): string | undefined => {
      if (o.status === "failed") return "执行失败";
      if (o.submitted === false) return `未按协议交卷（${SUBMIT_STEP_TOOL} 未被调用），没有可信产出`;
      if (o.contractFulfilled === false) return "产出合约未满足";
      const last = o.reviews?.at(-1);
      if (last && last.verdict !== "pass") {
        return last.verdict === "reject" ? "末轮评审未通过" : "评审人未给出有效结论，本步未获有效评审";
      }
      return undefined;
    };
    const failed = outcomes
      .map((o) => ({ o, reason: incompleteReason(o) }))
      .filter((x): x is { o: StepOutcome; reason: string } => Boolean(x.reason));
    const notRun = plan.steps.filter((s) => !outcomes.some((o) => o.id === s.id));
    // 员工的确认项：过去只是员工正文里的一段【需澄清】，无人消费也无人追责。
    // 落成清单摆在这里，收尾时必须逐条表态——判不了的才上抛老板。
    const pending = outcomes.flatMap((o) =>
      (o.escalations ?? []).map((e) => ({ step: o.title, ...e })),
    );
    return [
      "【编队执行完毕，进入你的收尾阶段】",
      `任务目标：${plan.goal}`,
      plan.acceptance ? `整体验收标准：${plan.acceptance}` : "",
      history.length > 0
        ? `## 历史轮次记录（你此前已重新编队过）\n${this.renderOutcomes(history)}`
        : "",
      `## 本轮各步骤执行与评审记录\n${this.renderOutcomes(outcomes) || "（本轮没有任何步骤产出）"}`,
      pending.length > 0
        ? [
            "## 员工提出的确认项（确定性清单，**每一条都必须表态**）",
            ...pending.map((e, i) =>
              [
                `${i + 1}. 来自「${e.step}」：${e.question}`,
                e.options?.length ? `   候选：${e.options.join(" / ")}` : "",
                e.leadAnswer
                  ? `   你当时的答复：${truncate(e.leadAnswer, 300)}（如已落实，在 verification 里说明）`
                  : "   ⚠️ 你还没答过这一条。",
              ]
                .filter(Boolean)
                .join("\n"),
            ),
            `每条三选一：① 你自己定（写进 conclusion/verification）；② 定不了就用 ${ASK_USER_TOOL} 上抛给老板，问题里带上你的建议；③ 明确判为本次不做，写进 risks 的遗留项。`,
            "不许对任何一条不作声——员工是拿不到用户的，这些确认只能由你处理。",
          ].join("\n")
        : "",
      failed.length > 0 || notRun.length > 0
        ? [
            "## ⚠️ 引擎判定：本轮存在未完成项（确定性事实，不是推测）",
            ...failed.map(({ o, reason }) => `- 步骤「${o.title}」(${o.id})：${reason}`),
            ...notRun.map((s) => `- 步骤「${s.title}」(${s.id}) **一次都没执行**`),
            "这些活没干完就不能报 done。",
          ].join("\n")
        : "",
      "现在请你按提示词里的阶段四要求收尾：",
      "1. 亲自复核——产物就在当前工作目录，用 Read/Bash 抽查关键交付物，别只看上面的文字结论；",
      "2. 对照验收标准逐条核对；",
      "3. 然后二选一：",
      canReplan
        ? [
            `   a) **还有活没干完** → 直接调 submit_plan 重新编队（只排剩下要做的步骤）。系统会真的按新计划执行一轮，执行完再回到本阶段。不要只用文字说「我会重新编队」——那不会触发任何执行。`,
            "   b) **已经收尾** → 调用 report_task_done 按组长模板交卷（verification 必须写你实际复核了什么 + 各步评审/重做记录；未过验收的写进 risks）。",
          ].join("\n")
        : [
            "   a) **重新编队额度已用尽**，不能再提新计划。",
            "   b) 调用 report_task_done 按现状交卷：没做完的逐条写进 risks，主体没完成就用 outcome=cannot_complete。",
          ].join("\n"),
      `需要用户拍板才能继续的，改用 ${ASK_USER_TOOL} 提问。`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * 跑一段组长自己的会话，流出事件，顺带捕获两个协议信号：
   * - submit_plan：**仅接受通过校验的 plan**（未过校验的工具已回错误、组长会重提，
   *   引擎绝不能拿非法 plan 去执行）
   * - report_task_done：交卷信号，用于区分「组长收尾交卷」与「组长要求重新编队」
   */
  private async *leadTurn(
    input: RunInput,
    prompt: string,
  ): AsyncGenerator<AgentEvent, { plan?: TeamPlan; reported: boolean }> {
    let plan: TeamPlan | undefined;
    let reported = false;
    for await (const e of this.runInstrumented({ ...input, prompt })) {
      if (e.event === "tool_call" && e.data.name === "submit_plan") {
        const raw = e.data.input as TeamPlan | undefined;
        if (raw?.goal && Array.isArray(raw.steps) && raw.steps.length > 0) {
          const errs = await validateTeamPlan(raw, this.name);
          if (errs.length === 0) plan = raw;
          else console.warn(`[lead] 丢弃未过校验的 plan：${errs.join("；")}`);
        }
      }
      if (e.event === "tool_call" && e.data.name === REPORT_DONE_TOOL) reported = true;
      yield e;
    }
    return { ...(plan ? { plan } : {}), reported };
  }

  override async *run(input: RunInput): AsyncGenerator<AgentEvent> {
    const taskId =
      typeof input.params?.taskId === "string" && input.params.taskId
        ? input.params.taskId
        : `local-${String(input.params?.chatId ?? "cli")}`;
    const cwd = this.resolveRunCwd(input);
    mkdirSync(cwd, { recursive: true });
    const runInput: RunInput = { ...input, cwd };
    const depth = Number(input.params?.__depth ?? 0);

    // 显式标注类型：state 在下面的循环里会被重新赋值（重新编队），
    // 靠推断会形成自引用（TS7022）
    let state: SquadState;
    const restored = loadState(taskId);

    // ── 阶段一 & 二：澄清 + 定 plan（无断点状态时）
    if (restored) {
      state = restored;
    } else {
      const { plan } = yield* this.leadTurn(runInput, input.prompt);
      if (!plan) return; // 提问了（等用户回答）或未交 plan，本轮结束
      state = { plan, outcomes: [], phase: "executing" };
      saveState(taskId, state);
    }

    // ── 阶段三 ⇄ 阶段四：执行 → 收尾复核 →（组长若重新编队则回到执行）
    //
    // 收尾阶段的 submit_plan 必须被接住：组长实检产物后发现没干完、重新编队，是**正确行为**，
    // 早先这里把新 plan 静默丢弃后就结束 run，组长那句「已重新编队」反倒被 boss 验收
    // 当成完成证据（真实事故：任务 3b3385 三步没跑却判 done）。
    while (true) {
      if (state.phase === "executing") {
        const completed = new Map(state.outcomes.map((o) => [o.id, o]));
        const rt: SquadRuntime = {
          leadName: this.name,
          cwd,
          baseParams: { ...input.params },
          depth,
          ...(input.abortController ? { abortController: input.abortController } : {}),
          /**
           * 组长自执行回调：员工 escalate（blocking）时当场找组长拍板，以及
           * `employee: "lead"` 的自执行步。
           *
           * 早先这个回调**根本没接**（只有 config-workflow-agent 传了），所以组长自执行步
           * 一跑就抛「未提供 runLeadStep」，员工也没有任何找组长的路。
           *
           * 局限（已知、刻意接受）：回调签名返回字符串，这一轮的事件没法从这里向上冒泡到
           * 外层 run 的事件流，所以 web 上看不到这次问答，只在服务日志留痕。
           */
          runLeadStep: async (prompt, maxTurns) => {
            const parts: string[] = [];
            const turnInput: RunInput = {
              ...runInput,
              ...(maxTurns ? { maxTurns } : {}),
            };
            for await (const e of this.leadTurn(turnInput, prompt)) {
              if (e.event === "text") parts.push(e.data.text);
            }
            const answer = parts.join("").trim();
            console.log(`[lead] 组长自执行一轮（${answer.length} 字）：${prompt.slice(0, 60)}…`);
            return answer;
          },
          onStepDone: (o) => {
            const next = state!;
            next.outcomes = [...next.outcomes.filter((x) => x.id !== o.id), o];
            if (next.running?.stepId === o.id) delete next.running;
            saveState(taskId, next);
          },
          onStepRunning: (r: RunningStep) => {
            const next = state!;
            next.running = r;
            saveState(taskId, next);
          },
        };
        try {
          yield* executeTeamPlan(
            rt,
            state.plan,
            { prompt: input.prompt, params: input.params ?? {} },
            completed,
          );
        } catch (error) {
          // 整个编队被中断（如嵌套超限/用户打断）：不抛给 boss，交由组长在收尾阶段如实汇报
          console.warn("[lead] 编队中断，转入收尾汇报:", error);
        }
        state.phase = "wrapup";
        delete state.running; // 执行阶段结束，没有步骤在跑了
        saveState(taskId, state);
      }

      // ── 阶段四：收尾复核 + 交卷（真员工 run，带工具在共享目录实检）
      const replans = state.replans ?? 0;
      const canReplan = replans < MAX_REPLANS;
      const { plan: rePlan, reported } = yield* this.leadTurn(
        runInput,
        this.buildWrapUpPrompt(state.plan, state.outcomes, state.history ?? [], canReplan),
      );

      // 交卷了 → 本任务收口（boss 从 report_task_done 事件接管）
      if (reported) break;

      // 没交卷但重新编队了 → 接住新 plan，回到阶段三真执行
      if (rePlan && canReplan) {
        state = {
          plan: rePlan,
          outcomes: [],
          phase: "executing",
          replans: replans + 1,
          history: [...(state.history ?? []), ...state.outcomes],
        };
        saveState(taskId, state);
        continue;
      }

      // 既没交卷也没（可执行的）新 plan：提问等用户回答，或组长沉默/重编队额度用尽。
      // 沉默与额度用尽都不能就这么结束——boss 兜底验收只看文本，容易把「计划」误判成「完成」。
      if (!rePlan) break;
      yield* this.leadTurn(
        runInput,
        [
          `【重新编队额度已用尽（已用 ${replans}/${MAX_REPLANS} 次）】`,
          "不能再提新计划了。请立刻按现状交卷：",
          "- 已完成的写进 conclusion / deliverables；",
          "- 没做完的、以及你本想重新编队去做的事，逐条写进 risks；",
          "- 若主体工作确实没完成，用 outcome=cannot_complete，不要报成 done。",
        ].join("\n"),
      );
      break;
    }

    clearState(taskId);
  }
}
