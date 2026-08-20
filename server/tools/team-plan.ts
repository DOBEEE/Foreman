import type { TeamPlan } from "../agents/squad/types.js";

/**
 * 编队 plan 工具常量与验证逻辑。
 *
 * 实际 tool 实现在 server/runtime/tools/protocol-tools.ts (buildSubmitPlanTool)。
 * 本文件保留常量与 validateTeamPlan 业务逻辑。
 */

/** 工具在 Vercel AI inline tools 中的注册名（= protocolTools 的 key） */
export const SUBMIT_PLAN_TOOL = "submit_plan";

/**
 * 编队 plan 校验：员工存在且可路由、不能指派 lead 自己、id 唯一。
 * 返回错误数组（空 = 合法）。
 */
export async function validateTeamPlan(plan: TeamPlan, leadId: string): Promise<string[]> {
  const errs: string[] = [];
  if (!plan.goal?.trim()) errs.push("goal 不能为空");
  if (!plan.steps?.length) errs.push("steps 不能为空");
  if ((plan.steps?.length ?? 0) > 8) errs.push("steps 过多（>8），请合并粒度");
  const { getAgent } = await import("../agents/registry.js");
  const ids = new Set<string>();
  for (const [i, s] of (plan.steps ?? []).entries()) {
    const at = `steps[${i}]`;
    if (ids.has(s.id)) errs.push(`${at}.id 重复：${s.id}`);
    ids.add(s.id);
    if (s.employee === "temp") {
      if (!s.temp?.role?.trim()) errs.push(`${at} employee="temp" 但缺 temp.role 规格`);
    } else if (s.employee === leadId || s.employee === "lead") {
      errs.push(`${at}.employee 不能指派组长自己（收尾复核是系统自动安排的）`);
    } else if (!getAgent(s.employee)) {
      errs.push(`${at}.employee 员工不存在：${s.employee}`);
    }
    if (s.reviewer) {
      if (s.reviewer === "temp") {
        errs.push(`${at}.reviewer 不能是临时工——评审必须由正式员工负责`);
      } else if (s.reviewer === leadId || s.reviewer === "lead") {
        errs.push(`${at}.reviewer 不能指派组长自己（收尾复核是系统自动安排的）`);
      } else if (!getAgent(s.reviewer)) {
        errs.push(`${at}.reviewer 员工不存在：${s.reviewer}`);
      }
    }
    if (s.reviewer && s.reviewer === s.employee)
      errs.push(`${at} 评审人不能与执行者相同（自审无效）`);
  }
  return errs;
}
