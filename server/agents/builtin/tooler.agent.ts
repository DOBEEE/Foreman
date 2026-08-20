import { join, relative, resolve } from "node:path";
import type { ToolGuard } from "../../runtime/hooks.js";
import { config } from "../../config/index.js";
import { builtinAgentsDir } from "../../config/paths.js";
import { listOptionalServerNames, loadMcpServers } from "../../core/mcp.js";
import type { RunInput } from "../../core/runner.js";
import { BaseAgent } from "../base-agent.js";
import { getAgent, listAgents } from "../registry.js";

/** 从工具入参里取出所有可能的路径字段 */
function extractPaths(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const record = toolInput as Record<string, unknown>;
  return ["file_path", "path", "notebook_path"]
    .map((key) => record[key])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * 工具管理员：接入新工具（MCP / skill）+ 配置员工权限 + 鉴权引导。
 * 声明式配置见 server/config/agents/tooler.json；这里只放代码行为：
 * - Write/Edit 只许落在 config.runtimeDir（用户目录，默认 ~/.foreman/）内（内置配置随 git，机制上禁止改动）
 * - 注入团队/工具现状模板参数，避免模型盲猜文件位置与字段现值
 */
export class ToolerAgent extends BaseAgent {
  readonly name = "tooler";

  /** 写入范围门禁：Write/Edit 目标必须在 runtimeDir 内 */
  protected readonly sdkGuards: ToolGuard[] = [
    async (toolName, input) => {
      if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
        return { allow: true };
      }
      for (const raw of extractPaths(input)) {
        const target = resolve(config.runtimeDir, raw);
        if (relative(config.runtimeDir, target).startsWith("..")) {
          return {
            deny: true,
            reason: `拒绝写入 ${raw}：工具管理员只允许写 ${config.runtimeDir} 内的用户配置（内置配置随 git 管理，不可改）`,
          };
        }
      }
      return { allow: true };
    },
  ];

  /** 团队与工具现状注入提示词（每次运行取实时值） */
  protected buildTemplateParams(input: RunInput): Record<string, unknown> {
    const employees = listAgents().map((a) => {
      const profile = getAgent(a.name)?.profile;
      return {
        id: a.name,
        displayName: a.displayName,
        description: a.description,
        source: profile?.source ?? "builtin",
        tools: profile?.tools ?? [],
        mcpServers: profile?.mcpServers ?? [],
        skills: profile?.skills ?? [],
      };
    });
    return {
      ...super.buildTemplateParams(input),
      userDir: config.runtimeDir,
      userMcpFile: config.userMcpFile,
      builtinMcpFile: join(config.configDir, "mcp.servers.json"),
      userPluginsDir: config.userPluginsDir,
      hiredAgentsDir: config.hiredAgentsDir,
      builtinAgentsDir,
      globalServers: Object.keys(loadMcpServers() ?? {}).join(", ") || "（无）",
      optionalServers: listOptionalServerNames().join(", ") || "（无）",
      employees: JSON.stringify(employees, null, 2),
    };
  }
}
