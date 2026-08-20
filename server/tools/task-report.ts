import { ASK_USER_TOOL } from "./ask-user.js";
import { SUBMIT_PLAN_TOOL } from "./team-plan.js";

/**
 * 交卷工具常量、类型与业务逻辑。
 *
 * 实际 tool 实现在 server/runtime/tools/protocol-tools.ts (buildReportDoneTool)。
 * 本文件保留：常量、TaskReport 类型、渲染/判断函数、delivery guard 信号追踪。
 */

/** 工具在 Vercel AI inline tools 中的注册名（= protocolTools 的 key） */
export const REPORT_DONE_TOOL = "report_task_done";

/** report_task_done 的结构化入参 */
export interface TaskReport {
  outcome: "done" | "cannot_complete";
  conclusion: string;
  deliverables?: string;
  verification?: string;
  risks?: string;
  /** 关键决策与理由。schema 里是必填，这里仍标可选——历史任务的存档没有这个字段 */
  decisions?: string;
}

// ── Delivery Guard 信号追踪 ──────────────────────────────────
// 用于判定一轮里是否出现过「提问」或「交卷」信号

const signals = new Map<string, Set<string>>();

export const SIGNAL_TOOLS = new Set([
  ASK_USER_TOOL,
  "AskUserQuestion",
  REPORT_DONE_TOOL,
  SUBMIT_PLAN_TOOL,
]);

export function markSignal(sessionId: string | undefined, toolName: string): void {
  if (!sessionId || !SIGNAL_TOOLS.has(toolName)) return;
  const set = signals.get(sessionId) ?? new Set<string>();
  set.add(toolName);
  signals.set(sessionId, set);
  if (signals.size > 500) {
    for (const k of [...signals.keys()].slice(0, 100)) signals.delete(k);
  }
}

export function hasSignal(sessionId: string): boolean {
  return (signals.get(sessionId)?.size ?? 0) > 0;
}

export function clearSignals(sessionId: string): void {
  signals.delete(sessionId);
}

/** 从 report_task_done 的入参渲染成「任务汇报」文本（boss 转达用） */
export function renderTaskReport(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const r = input as Partial<TaskReport>;
  if (!r.conclusion) return undefined;
  const lines = [
    "**任务汇报**",
    `- **结论**：${r.conclusion}`,
    `- **交付物**：${r.deliverables?.trim() || "无"}`,
    `- **验证**：${r.verification?.trim() || "无"}`,
    `- **风险与遗留**：${r.risks?.trim() || "无"}`,
  ];
  // 有实质内容才渲染：验收员拿到的就是这份文本，看得到取舍有助于判断结论是否站得住；
  // 但填「无」时不该占一行给用户添噪音（其余字段是固定四项，缺了反而像漏了）。
  const decisions = r.decisions?.trim();
  if (decisions && !/^无[。.]?$/.test(decisions)) {
    lines.push(`- **关键决策**：${decisions}`);
  }
  if (r.outcome === "cannot_complete") lines.splice(1, 0, "- **状态**：未能完成");
  return lines.join("\n");
}

/** 判断一次交卷是否为「无法完成」 */
export function isCannotComplete(input: unknown): boolean {
  return (
    Boolean(input) &&
    typeof input === "object" &&
    (input as Partial<TaskReport>).outcome === "cannot_complete"
  );
}
