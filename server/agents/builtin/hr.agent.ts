import { config } from "../../config/index.js";

import { getBuiltinAgentIds, listAgents } from "../registry.js";
import { buildToolCatalog } from "../../tools/catalog.js";
import type { RunInput } from "../../core/runner.js";
import type { AgentOptions } from "../../types/agent-options.js";
import { BaseAgent } from "../base-agent.js";
import { buildProposeNewHireTool, buildSaveEmployeeTool } from "./hr-tools.js";

/**
 * 人事 agent：负责「新增/配置团队成员」。boss 把「招个人 / 加个员工 / 配一个新角色」
 * 类诉求路由到这里。它交互式收集字段 → 校验 → 用 save_employee 工具落盘
 * （<runtimeDir>/agents/<id>.json）。配置写完后 registry 会在下一条消息热加载，
 * 新员工立即可被所有渠道路由到。
 *
 * 安全：
 * - **不持有 Write**。落盘只能走 save_employee，那里有严格校验；更关键的是 hr 的工作目录
 *   就是 hiredAgentsDir，有 Write 就能写与内置岗位同名的文件，那会被当成权限覆盖层
 *   浅合并进内置员工——等于给任意内置员工任意开权限。
 * - 默认只授予只读工具；用户要 Bash/Write/Edit 等高权限工具时，hire-employee skill
 *   要求先经 ask_user 二次确认。
 */
export class HrAgent extends BaseAgent {
  readonly name = "hr";

  override buildOptions(
    input: Parameters<BaseAgent["buildOptions"]>[0],
  ): AgentOptions & { protocolTools?: Record<string, unknown> } {
    const opts = super.buildOptions(input);
    return {
      ...opts,
      protocolTools: {
        ...(opts.protocolTools ?? {}),
        save_employee: buildSaveEmployeeTool(),
        propose_new_hire: buildProposeNewHireTool(),
      },
    };
  }

  protected buildTemplateParams(input: RunInput): Record<string, unknown> {
    const catalog = buildToolCatalog();
    return {
      ...super.buildTemplateParams(input),
      agentsDir: config.hiredAgentsDir,
      existingAgents: JSON.stringify(listAgents(), null, 2),
      builtinIds: getBuiltinAgentIds().join(", "),
      readonlyTools: catalog.readonly.join(", "),
      highPrivTools: catalog.highPriv.join(", "),
      mcpTools: catalog.mcp.length ? catalog.mcp.join(", ") : "（无全局 MCP server）",
      capabilityTools: catalog.capability
        .map((t) => `${t.name}（${t.description}）`)
        .join("；"),
      optionalMcp: catalog.optional.length
        ? catalog.optional.join(", ")
        : "（无按需 MCP server）",
      defaultModel: config.model ?? "（全局默认）",
    };
  }
}
