import { listOptionalServerNames, loadMcpServers } from "../core/mcp.js";
import { config } from "../config/index.js";

/** 本环境跑不通的工具不进目录，避免授了一个用不了的权限 */
function usable(tools: readonly string[]): string[] {
  return tools.filter((t) => !config.disabledTools.includes(t));
}

/**
 * 招聘 skill / dashboard 用的工具目录：给 boss/hr 一份可选清单，避免瞎填。
 * 分「只读安全」与「高权限（可改文件/执行命令）」两档，配合招聘时的确认策略。
 */
export const READONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
] as const;

export const HIGH_PRIV_TOOLS = ["Write", "Edit", "Bash", "Task", "TodoWrite"] as const;

/**
 * 能力型工具（in-process MCP，需显式点名才挂载）：
 * - schedule_later：把一件事延后到将来某时刻再做（仅一次性；周期任务由主管创建）
 */
export const CAPABILITY_TOOLS = [
  {
    name: "schedule_later",
    description: "延后办：把任务安排到将来某时刻再执行（一次性，≤24h）。适合需要等构建/等发布再复查的岗位",
  },
] as const;

export interface ToolCatalog {
  readonly: string[];
  highPriv: string[];
  /** 全局 MCP server 名 → 建议白名单写法 mcp__<server> */
  mcp: string[];
  /** 按需 MCP server 名：写进岗位配置的 mcpServers 字段才会挂载 */
  optional: string[];
  /** 能力型工具：写进 tools 白名单才生效 */
  capability: { name: string; description: string }[];
}

export function buildToolCatalog(): ToolCatalog {
  const servers = loadMcpServers() ?? {};
  return {
    readonly: usable(READONLY_TOOLS),
    highPriv: usable(HIGH_PRIV_TOOLS),
    mcp: Object.keys(servers).map((s) => `mcp__${s}`),
    optional: listOptionalServerNames(),
    capability: CAPABILITY_TOOLS.map((t) => ({ ...t })),
  };
}

/**
 * 临时工默认工具集：只读 + 写文件 + 执行命令。
 * 临时工干的是「无人负责的辅助活」，只给只读会让它能做的事太有限；
 * 不含 Task（不许再派生 subagent，避免嵌套失控），组长可在 temp.tools 里显式收窄。
 */
export const TEMP_DEFAULT_TOOLS = [
  ...READONLY_TOOLS,
  "Write",
  "Edit",
  "Bash",
] as const;

export function isHighPrivTool(tool: string): boolean {
  return (HIGH_PRIV_TOOLS as readonly string[]).includes(tool);
}
