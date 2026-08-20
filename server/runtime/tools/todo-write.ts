import { tool } from "ai";
import { z } from "zod";

/**
 * TodoWrite 工具：会话级任务追踪清单。
 * 对齐 Claude Code 的 TodoWrite 语义：agent 用它记录和更新当前任务的步骤列表，
 * 帮助自己保持进度意识（特别是长上下文中不忘步骤）。
 *
 * 状态存在内存中（按 sessionKey 隔离），run 结束即清。
 * 如需跨 run 持久化，上层可在 afterRun 时把 getTodos() 落盘。
 */

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done";
  priority?: "high" | "medium" | "low";
}

const store = new Map<string, TodoItem[]>();

export function getTodos(sessionKey: string): TodoItem[] {
  return store.get(sessionKey) ?? [];
}

export function clearTodos(sessionKey: string): void {
  store.delete(sessionKey);
}

export function buildTodoWriteTool(sessionKey: string) {
  const todoParams = z.object({
    todos: z.array(
      z.object({
        id: z.string().describe("Stable identifier for the item"),
        content: z.string().describe("What needs to be done"),
        status: z
          .enum(["pending", "in_progress", "done"])
          .describe("Current status"),
        priority: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("Priority level"),
      }),
    ),
  });

  return tool({
    description:
      "Create or update your task tracking list. Use this to plan multi-step work, " +
      "track progress, and avoid forgetting steps during long tasks. " +
      "Each call replaces the full todo list (send the complete updated list every time).",
    inputSchema: todoParams,
    execute: async (input) => {
      store.set(sessionKey, input.todos);
      const summary = input.todos
        .map(
          (t) =>
            `[${t.status === "done" ? "✓" : t.status === "in_progress" ? "→" : " "}] ${t.content}`,
        )
        .join("\n");
      return `Todo list updated (${input.todos.filter((t) => t.status === "done").length}/${input.todos.length} done):\n${summary}`;
    },
  });
}
