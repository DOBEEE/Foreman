import { tool } from "ai";
import { z } from "zod";
import {
  hiredProfileExists,
  saveHiredProfile,
  validateAgentProfile,
  type AgentProfile,
} from "../../config/agent-profile.js";
import { getBuiltinAgentIds, listAgents } from "../registry.js";
import { createNewHireProposal } from "../../boss/proposals.js";

/**
 * hr 的落盘工具。
 *
 * 为什么必须是工具而不是让 hr 用 `Write` 自己写 JSON：
 * 1. 裸 Write 绕过 saveHiredProfile 的严格校验（displayName/description/systemPrompt
 *    必填、sop steps 完整性），写出跑不起来的员工。
 * 2. **更要紧的是提权**：hr 的工作目录就是 hiredAgentsDir，有 Write 就能写 `coder.json`；
 *    而与内置岗位同名的文件会被 loadAgentProfile 当作**非严格校验的权限覆盖层**浅合并，
 *    等于可以给任意内置员工开 Bash/Write/任意 MCP。这条路必须堵死。
 */

const profileSchema = z.object({
  id: z.string().describe("路由名 / 文件名，2-40 位小写字母开头的 slug"),
  displayName: z.string().describe("拟人化展示名，如「小译」"),
  description: z.string().describe("一句话职责"),
  routeHint: z
    .string()
    .describe("路由职责卡，必须含【选我当】与【别选我当】两段，用来和现有同事划清边界"),
  systemPrompt: z.string().describe("系统提示词：身份、工作方式、产出要求、判断口径"),
  type: z.enum(["simple", "sop"]).optional().describe("sop=多步接力岗位，需同时给 steps"),
  steps: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        prompt: z.string(),
        mode: z.enum(["self", "delegate"]).optional(),
        delegate: z.string().optional(),
        reviewer: z.string().optional(),
        accept: z.string().optional(),
        maxRetries: z.number().int().min(0).optional(),
        maxTurns: z.number().int().positive().optional(),
      }),
    )
    .optional()
    .describe("type=sop 时的步骤清单"),
  tools: z.array(z.string()).optional().describe("工具白名单。高权限工具需先经 ask_user 确认"),
  mcpServers: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().optional(),
  maxThinkingTokens: z.number().optional(),
  workspacePolicy: z.enum(["shared", "per-chat", "per-task", "per-run"]).optional(),
  maxParallel: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("同一会话内可同时进行的任务数，缺省 1（串行）。大于 1 必须同时设 workspacePolicy=per-task"),
});

function validateEmployeeRefs(profile: AgentProfile): string[] {
  const employeeIds = new Set(listAgents().map((agent) => agent.name).filter((id) => id !== "hr"));
  const errs: string[] = [];
  // 岗位级评审人（该岗位产出默认由谁验收），判据与 step.reviewer 一致
  if (profile.reviewer && !employeeIds.has(profile.reviewer)) {
    errs.push(`reviewer 指向不存在或不可委派的员工：${profile.reviewer}`);
  }
  for (const [index, step] of profile.steps?.entries() ?? []) {
    if (step.delegate && !employeeIds.has(step.delegate)) {
      errs.push(`steps[${index}].delegate 指向不存在或不可委派的员工：${step.delegate}`);
    }
    if (step.reviewer && !employeeIds.has(step.reviewer)) {
      errs.push(`steps[${index}].reviewer 指向不存在或不可委派的员工：${step.reviewer}`);
    }
  }
  return errs;
}

export function buildSaveEmployeeTool() {
  return tool({
    description: [
      "把一位员工的配置写入团队（新增或覆盖更新）。**只能用这个工具落盘**，不要试图自己写文件。",
      "写入前会严格校验；校验不过会把问题原样返回给你，改完再调一次。",
      "id 不得与内置岗位重名。高权限工具（Write/Edit/Bash/Task）必须先用 ask_user 向用户确认过再填。",
    ].join("\n"),
    inputSchema: z.object({
      profile: profileSchema,
      /** 覆盖已有员工需显式声明，避免手滑改掉别人 */
      overwrite: z.boolean().optional().describe("目标 id 已存在时必须显式传 true"),
    }),
    execute: async ({ profile, overwrite }) => {
      const builtinIds = getBuiltinAgentIds();
      if (builtinIds.includes(profile.id)) {
        return `拒绝写入：「${profile.id}」是内置岗位名，不能用它建员工也不能覆盖它。请换一个 id。`;
      }
      if (hiredProfileExists(profile.id) && overwrite !== true) {
        return `「${profile.id}」已经存在。确认要覆盖就带 overwrite=true 再调一次；想新建请换 id。`;
      }
      const next: AgentProfile = {
        ...profile,
        type: profile.type ?? "simple",
        workspace: "auto",
        createdAt: new Date().toISOString(),
        createdBy: "hr",
      };
      const errs = [...validateAgentProfile(next, true), ...validateEmployeeRefs(next)];
      if (errs.length > 0) return `配置没通过校验，请修正后重试：\n- ${errs.join("\n- ")}`;
      try {
        saveHiredProfile(next);
      } catch (error) {
        return `写入失败：${error instanceof Error ? error.message : String(error)}`;
      }
      return `已写入员工「${next.displayName}」（${next.id}），现在就能把对应任务派给他。`;
    },
  });
}

/**
 * 归纳建岗提案工具。
 *
 * 与 save_employee 的区别不是权限而是**谁拍板**：归纳出来的岗位是系统主动提议的
 * （用户没提过要招人），必须由用户批准才落盘；save_employee 是用户当场让 hr 招人，
 * 意图已经在了。所以这里只产提案，落盘由 applyProposal 走确定性路径。
 */
export function buildProposeNewHireTool() {
  return tool({
    description: [
      "提交一条「设立通用岗位」的待审提案（归纳建岗时用这个，**不要**用 save_employee 直接落盘）。",
      "用户批准后系统会自动落盘并让他进团队名册；驳回则那批台账记录标为已谢绝、不再重复来问。",
      "证据不足（同类活次数太少、几件活其实不同类）就不要提，如实说明理由即可。",
    ].join("\n"),
    inputSchema: z.object({
      profile: profileSchema,
      summary: z
        .string()
        .describe("一句话说清为什么该设这个岗：这类活出现了几次、共性是什么"),
      ledgerIds: z
        .array(z.string())
        .describe("支撑本次建岗的台账记录 id（聚合摘要里每条都给了，如 tl-xxx-tmp-yyy）"),
      capabilitySlugs: z.array(z.string()).describe("本提案覆盖的能力域 slug（摘要里给了）"),
      taskIds: z.array(z.string()).optional().describe("证据任务号，供用户核对"),
    }),
    execute: async ({ profile, summary, ledgerIds, capabilitySlugs, taskIds }) => {
      if (getBuiltinAgentIds().includes(profile.id) || hiredProfileExists(profile.id)) {
        return `id「${profile.id}」已被占用（内置岗位或现有员工），换一个再提。`;
      }
      if (ledgerIds.length === 0) return "没给 ledgerIds，提案无从核对证据。请从聚合摘要里把记录 id 带上。";
      const draft: AgentProfile = {
        ...profile,
        type: profile.type ?? "simple",
        workspace: "auto",
      };
      const errs = [...validateAgentProfile(draft, true), ...validateEmployeeRefs(draft)];
      if (errs.length > 0) return `配置没通过校验，请修正后重试：\n- ${errs.join("\n- ")}`;
      const p = createNewHireProposal({
        profileDraft: draft,
        ledgerIds,
        capabilitySlugs,
        summary,
        ...(taskIds?.length ? { evidence: taskIds } : {}),
      });
      return `已提交建岗提案 ${p.id}（岗位「${draft.displayName}」）。等用户回「批准 ${p.id}」才会落盘。`;
    },
  });
}
