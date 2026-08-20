import { randomUUID } from "node:crypto";
import { getRuntime } from "../../runtime/index.js";
import { WorkflowAgent } from "../../workflow/workflow-agent.js";
import { saveTaskRecord } from "../../workflow/task-store.js";
import type { StepContext, StepDef, TaskRecord } from "../../workflow/types.js";
import { resolveWorkspace, type SopStep } from "../../config/agent-profile.js";
import { config } from "../../config/index.js";
import {
  executeTeamPlan,
  renderStepTemplate,
  type SquadRuntime,
} from "../squad/executor.js";
import type { TeamPlan } from "../squad/types.js";
import {
  collectRun,
  executeQuery,
  type AgentEvent,
  type RunInput,
} from "../../core/runner.js";

/**
 * SOP 型员工（配置驱动的常任小组长）：profile.steps 就是写死在配置里的编队 plan。
 * 执行走通用编队执行器（agents/squad/executor.ts），与 lead 岗位的临时编队同一套机制：
 * - self 步（mode=self）→ employee="lead"，用本岗位自己的会话执行
 * - delegate 步 → 进程内委派（注入编队协议）+ reviewer 真人评审 / accept 轻量验收循环
 * - 委派不重走 boss/任务队列，也不重抢全局并发闸门（组长已获准，子调用属其工作的一部分）
 * 最终产出整合汇报作为 finalAnswer；追问态复用 WorkflowAgent 的任务档案锚点会话。
 */
export class ConfigWorkflowAgent extends WorkflowAgent {
  readonly name: string;

  constructor(id: string) {
    super();
    this.name = id;
  }

  /** 配置里的 SOP 步骤 */
  private get sopSteps(): SopStep[] {
    return this.profile.steps ?? [];
  }

  /** 供追问态/类型兼容：把 SOP 步渲染为 StepDef（实际执行走本类覆写的 runWorkflow） */
  get steps(): StepDef[] {
    return this.sopSteps.map((s) => ({
      id: s.id,
      title: s.title,
      buildPrompt: (ctx: StepContext) =>
        renderStepTemplate(s.prompt, {
          input: ctx.input,
          params: ctx.params,
          conclusionOf: ctx.conclusionOf,
          fieldOf: () => undefined,
        }),
      ...(s.maxTurns ? { maxTurns: s.maxTurns } : {}),
    }));
  }

  protected override resolveCwd(): string {
    return resolveWorkspace(this.profile);
  }

  /** 小组长自称：展示名优先，回落路由 id */
  private get leadName(): string {
    return this.displayName ?? this.name;
  }

  /** profile.steps → 编队 plan（同一 schema，来源不同而已） */
  private buildPlan(input: RunInput): TeamPlan {
    return {
      goal: input.prompt.slice(0, 400),
      steps: this.sopSteps.map((s) => ({
        id: s.id,
        title: s.title,
        employee: s.mode === "delegate" ? s.delegate! : "lead",
        brief: s.prompt,
        ...(s.reviewer ? { reviewer: s.reviewer } : {}),
        ...(s.accept ? { accept: s.accept } : {}),
        ...(s.maxRetries != null ? { maxRetries: s.maxRetries } : {}),
        ...(s.maxTurns ? { maxTurns: s.maxTurns } : {}),
        ...(s.produces ? { produces: s.produces } : {}),
        ...(s.needs ? { needs: s.needs } : {}),
      })),
    };
  }

  protected override async *runWorkflow(input: RunInput): AsyncGenerator<AgentEvent> {
    const depth = Number(input.params?.__depth ?? 0);
    const startedAt = Date.now();
    const leadCwd = this.resolveRunCwd(input);
    const record: TaskRecord = {
      taskId: randomUUID(),
      agent: this.name,
      input: input.prompt,
      time: new Date().toISOString(),
      steps: [],
    };
    let error: unknown;

    const rt: SquadRuntime = {
      leadName: this.name,
      cwd: leadCwd,
      baseParams: { ...input.params },
      depth,
      ...(input.abortController ? { abortController: input.abortController } : {}),
      // self 步：小组长自己做（共享 leadCwd，独立会话）
      runLeadStep: async (prompt, maxTurns) => {
        const stepInput: RunInput = {
          ...input,
          prompt,
          cwd: leadCwd,
          resume: undefined,
          persistSession: true,
          maxTurns: maxTurns ?? input.maxTurns,
        };
        const { text, summary } = await collectRun(
          executeQuery(stepInput.prompt, this.buildOptions(stepInput)),
        );
        if (!summary || summary.isError) {
          throw new Error(`自执行步失败: ${summary?.result ?? summary?.subtype ?? "流中断"}`);
        }
        return text;
      },
      onStepDone: (o) => {
        record.steps.push({
          id: o.id,
          title: o.title,
          status: o.status,
          conclusion: o.conclusion,
          durationMs: o.durationMs,
        });
      },
    };

    try {
      this.ensureCwd(input);
      await this.beforeRun(input);

      yield* executeTeamPlan(rt, this.buildPlan(input), {
        prompt: input.prompt,
        params: input.params ?? {},
      });

      record.finalAnswer = await this.synthesizeReport(record);
      saveTaskRecord(record);
      yield { event: "text", data: { text: record.finalAnswer } };
      yield {
        event: "result",
        data: {
          subtype: "success",
          isError: false,
          result: record.finalAnswer,
          taskId: record.taskId,
          durationMs: Date.now() - startedAt,
        },
      };
    } catch (e) {
      error = e;
      saveTaskRecord(record); // 半途失败也落档，便于排障
      throw e;
    } finally {
      await this.afterRun(input, { error });
    }
  }

  /** 轻量 LLM 单轮（无工具）：整合汇报用 */
  private async askLead(prompt: string): Promise<string> {
    const result = await getRuntime().complete({
      prompt,
      model: this.profile.model ?? config.model,
      cwd: this.resolveCwd(),
    });
    return result.text.trim();
  }

  /** 整合各步结论 → 面向 boss/用户的验收汇报（LLM 综合，失败回落拼接） */
  private async synthesizeReport(record: TaskRecord): Promise<string> {
    const stepsBrief = record.steps
      .map((s) => `### ${s.title}（${s.status}）\n${s.conclusion}`)
      .join("\n\n");
    const prompt = [
      `你是「${this.leadName}」，${this.description}。`,
      this.profile.systemPrompt ?? "",
      "以下是本次任务各步骤的执行与验收结果，请你作为小组长整合成一份给上级的交付汇报：",
      `原始任务：${record.input}`,
      stepsBrief,
      "要求：突出最终成果与结论；如实说明未通过验收/失败的步骤及建议；简洁专业，直接说结论，不要罗列过程套话。",
    ].join("\n\n");
    try {
      const out = await this.askLead(prompt);
      if (out) return out;
    } catch {
      /* 回落拼接 */
    }
    return `【${this.leadName} · 任务汇报】\n\n${stepsBrief}`;
  }
}
