/**
 * 编队步骤交卷（`submit_step`）的常量、类型与渲染。
 *
 * 与 `task-report.ts`（员工对老板交卷）是同一条纪律的两个方向：
 * 员工对老板必须调 `report_task_done` 表态，「只输出文本就结束会被系统拦回来重做」；
 * 而编队内部**一直缺这一半**——步骤产出取的是整段流式文本（`parts.join("")`），
 * 于是组长收尾时看到的是旁白而不是结论，`produces.data` 只能靠轻量 LLM 反向刮取。
 *
 * 真实事故：`fix` 步配了 reviewer、评审也真跑了并给出 `pass:true`，但通过的评审
 * 不落任何字段，组长在收尾记录里看不到一个字，只能判「没经过 code-review」，
 * 又重新编队补跑一遍（logs/runs-2026-08-19 idx 20→21→22、idx 43→45、idx 50→51→52）。
 *
 * 实际 tool 实现在 `runtime/tools/protocol-tools.ts`（buildSubmitStepTool）；
 * 本文件只放常量、类型与渲染，避免业务层反向依赖 runtime。
 */

/** 工具注册名（= protocolTools 的 key，两个 runtime 都按裸名匹配） */
export const SUBMIT_STEP_TOOL = "submit_step";

/** 评审结论：inconclusive = 评审人没按协议交卷，既不算过也不算不过 */
export type ReviewVerdictKind = "pass" | "reject" | "inconclusive";

/** `submit_step` 的结构化入参 */
export interface StepReport {
  outcome: "done" | "cannot_complete";
  conclusion: string;
  deliverables?: string;
  verification?: string;
  risks?: string;
  decisions?: string;
  /** 评审角色专用：本步是否通过评审 */
  verdict?: "pass" | "reject";
  /** `produces.data` 声明的字段值：员工填，不再由引擎刮取 */
  data?: Record<string, string>;
}

/** 一次评审的落档记录（通过的那次也记——不记就等于没评过） */
export interface ReviewRecord {
  reviewer: string;
  verdict: ReviewVerdictKind;
  /** 评审人给出的结论正文 */
  conclusion?: string;
  /** reject 时的修改意见 / inconclusive 时的原因 */
  feedback?: string;
  /** 第几次执行后的这轮评审 */
  attempt: number;
}

function clean(s: string | undefined): string | undefined {
  const v = s?.trim();
  return v ? v : undefined;
}

/**
 * 交卷入参 → 步骤结论文本。
 *
 * 这份文本会成为 `StepOutcome.conclusion`，既给组长收尾看，也被下游步骤的
 * `{{step:<id>}}` 引用——所以只放结构化字段，不掺任何流式旁白。
 */
export function renderStepReport(report: StepReport): string {
  const lines: string[] = [];
  if (report.outcome === "cannot_complete") lines.push("**状态**：未能完成");
  lines.push(`**结论**：${report.conclusion.trim()}`);
  const deliverables = clean(report.deliverables);
  if (deliverables) lines.push(`**交付物**：${deliverables}`);
  const verification = clean(report.verification);
  if (verification) lines.push(`**验证**：${verification}`);
  const risks = clean(report.risks);
  if (risks && !/^无[。.]?$/.test(risks)) lines.push(`**风险与遗留**：${risks}`);
  const decisions = clean(report.decisions);
  if (decisions && !/^无[。.]?$/.test(decisions)) lines.push(`**关键决策**：${decisions}`);
  const data = Object.entries(report.data ?? {}).filter(([, v]) => clean(v));
  if (data.length > 0) {
    lines.push(`**关键信息**：${data.map(([k, v]) => `${k}=${v.trim()}`).join("；")}`);
  }
  return lines.join("\n");
}
