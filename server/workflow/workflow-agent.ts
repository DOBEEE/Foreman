import { randomUUID } from "node:crypto";
import { BaseAgent } from "../agents/base-agent.js";
import { appendRunLog } from "../core/logger.js";
import {
  collectRun,
  executeQuery,
  type AgentEvent,
  type ProgressData,
  type RunInput,
} from "../core/runner.js";
import { loadTaskRecord, saveTaskRecord } from "./task-store.js";
import type { StepContext, StepDef, TaskRecord } from "./types.js";

function progress(step: StepDef, status: ProgressData["status"]): AgentEvent {
  return {
    event: "progress",
    data: { id: step.id, title: step.title, status },
  };
}

/**
 * Workflow agent：代码编排多步骤，每步独立会话执行。
 * - 执行态：逐步骤 query，流出 progress 事件，结束落任务档案（含各步结论 + sessionId）
 * - 追问态：懒创建锚点答疑会话——首次追问注入任务档案开新会话，后续 resume 该会话
 * 对外只暴露 taskId 与锚点 sessionId，步骤会话对调用方不可见。
 */
export abstract class WorkflowAgent extends BaseAgent {
  abstract readonly steps: StepDef[];

  /** 答疑锚点会话的角色指令，子类可覆写 */
  protected readonly followUpGuide =
    "你是该任务的答疑助手。基于下方任务档案回答用户追问，引用档案中的结论与证据；档案没有的信息如实说明无法确认，不要编造。";

  async *run(input: RunInput): AsyncGenerator<AgentEvent> {
    const taskId =
      typeof input.params?.taskId === "string" ? input.params.taskId : undefined;
    if (input.resume || taskId) {
      yield* this.runFollowUp(input, taskId);
      return;
    }
    yield* this.runWorkflow(input);
  }

  protected async *runWorkflow(input: RunInput): AsyncGenerator<AgentEvent> {
    const startedAt = Date.now();
    const record: TaskRecord = {
      taskId: randomUUID(),
      agent: this.name,
      input: input.prompt,
      time: new Date().toISOString(),
      steps: [],
    };
    const ctx: StepContext = {
      input: input.prompt,
      params: input.params ?? {},
      conclusionOf: (id) => record.steps.find((s) => s.id === id)?.conclusion,
    };
    let totalTurns = 0;
    let error: unknown;

    try {
      this.ensureCwd();
      await this.beforeRun(input);

      // 先整树 pending，UI 可立即渲染全貌
      for (const step of this.steps) yield progress(step, "pending");

      for (const step of this.steps) {
        yield progress(step, "running");
        const stepStart = Date.now();
        try {
          const stepInput: RunInput = {
            ...input,
            prompt: step.buildPrompt(ctx),
            resume: undefined,
            persistSession: true,
            maxTurns: step.maxTurns ?? input.maxTurns,
          };
          const { text, summary } = await collectRun(
            executeQuery(stepInput.prompt, this.buildOptions(stepInput)),
          );
          if (!summary || summary.isError) {
            throw new Error(
              `步骤 ${step.id} 执行失败: ${summary?.result ?? summary?.subtype ?? "流中断"}`,
            );
          }
          totalTurns += summary.numTurns ?? 0;
          record.steps.push({
            id: step.id,
            title: step.title,
            status: "done",
            conclusion: step.parse?.(text) ?? text,
            sessionId: summary.sessionId,
            durationMs: Date.now() - stepStart,
          });
          yield progress(step, "done");
        } catch (stepError) {
          record.steps.push({
            id: step.id,
            title: step.title,
            status: "failed",
            conclusion:
              stepError instanceof Error ? stepError.message : String(stepError),
            durationMs: Date.now() - stepStart,
          });
          yield progress(step, "failed");
          throw stepError;
        }
      }

      record.finalAnswer = record.steps.at(-1)?.conclusion ?? "";
      saveTaskRecord(record);
      yield { event: "text", data: { text: record.finalAnswer } };
      yield {
        event: "result",
        data: {
          subtype: "success",
          isError: false,
          result: record.finalAnswer,
          taskId: record.taskId,
          numTurns: totalTurns,
          durationMs: Date.now() - startedAt,
        },
      };
    } catch (e) {
      error = e;
      saveTaskRecord(record); // 半途失败也落档，便于排障
      throw e;
    } finally {
      appendRunLog({
        time: new Date(startedAt).toISOString(),
        agent: this.name,
        prompt: input.prompt,
        params: { ...input.params, taskId: record.taskId },
        text: record.finalAnswer ?? "",
        toolCalls: [],
        numTurns: totalTurns,
        durationMs: Date.now() - startedAt,
        isError: Boolean(error),
        error:
          error instanceof Error ? error.message : error ? String(error) : undefined,
      });
      await this.afterRun(input, { error });
    }
  }

  /** 任务档案渲染进答疑会话系统提示词，子类可覆写调整格式 */
  protected buildFollowUpContext(record: TaskRecord): string {
    return [
      "## 任务档案",
      `- 原始输入: ${record.input}`,
      `- 完成时间: ${record.time}`,
      ...record.steps.map(
        (s) =>
          `### 步骤 ${s.id}: ${s.title}（${s.status}${s.sessionId ? ` · session ${s.sessionId}` : ""}）\n${s.conclusion}`,
      ),
      `## 最终结论\n${record.finalAnswer ?? "（任务未完成）"}`,
    ].join("\n\n");
  }

  protected async *runFollowUp(
    input: RunInput,
    taskId?: string,
  ): AsyncGenerator<AgentEvent> {
    this.ensureCwd();
    const options = this.buildOptions({ ...input, persistSession: true });

    // 首次追问（无锚点会话）：注入任务档案开新会话
    if (!input.resume) {
      const record = taskId ? loadTaskRecord(taskId) : undefined;
      if (!record) throw new Error(`任务档案不存在: ${taskId}`);
      const archive = `${this.followUpGuide}\n\n${this.buildFollowUpContext(record)}`;
      const prev = options.systemPrompt;
      const prevAppend =
        prev && typeof prev === "object" && !Array.isArray(prev)
          ? prev.append
          : undefined;
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: prevAppend ? `${prevAppend}\n\n${archive}` : archive,
      };
    }

    for await (const e of executeQuery(input.prompt, options)) {
      // result 补 taskId，维持调用方的档案关联
      if (e.event === "result" && taskId) {
        yield { event: "result", data: { ...e.data, taskId } };
      } else {
        yield e;
      }
    }
  }
}
