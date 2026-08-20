import { tool } from "ai";
import { z } from "zod";

/**
 * Delegate Task 工具：委派子任务给其他 agent（sub-agent 机制）。
 * 对齐 Claude Code 的 Task 工具语义：调用方 agent 可以把一段工作交给一个
 * 拥有独立 context window 的子 agent 完成，结果作为 tool result 返回。
 *
 * 具体执行逻辑由上层注入（闭包）——因为需要知道有哪些 agent、怎么 dispatch。
 * 这里只定义 tool schema + 占位 execute。
 */

export type DelegateHandler = (params: {
  agent: string;
  task: string;
  context?: string;
}) => Promise<string>;

export function buildDelegateTaskTool(handler: DelegateHandler) {
  const delegateParams = z.object({
    agent: z
      .string()
      .describe(
        "The sub-agent to delegate to (e.g. 'explorer' for read-only code search)",
      ),
    task: z
      .string()
      .describe(
        "Clear description of what the sub-agent should accomplish",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "Additional context to pass to the sub-agent (file paths, constraints, etc.)",
      ),
  });

  return tool({
    description:
      "Delegate a subtask to a specialized sub-agent with an isolated context window. " +
      "Use this when a subtask requires a different expertise or would benefit from a fresh context. " +
      "The sub-agent will complete the task and return its result.",
    inputSchema: delegateParams,
    execute: async (input) => {
      try {
        return await handler({ agent: input.agent, task: input.task, context: input.context });
      } catch (error) {
        return `[Delegation failed] ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
