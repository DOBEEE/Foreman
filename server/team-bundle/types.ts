import type { BossPersona } from "../boss/persona.js";
import type { McpScope } from "../config/mcp-store.js";
import type { SopStep, WorkspacePolicy } from "../config/agent-profile.js";

export const TEAM_BUNDLE_FORMAT = "ait-team" as const;
export const TEAM_BUNDLE_VERSION = 1 as const;

/** 可分享员工：刻意没有 model/provider/contextWindow/workspace/readRoots 等本机字段。 */
export interface PortableAgent {
  id: string;
  displayName?: string;
  avatar?: string;
  description?: string;
  routeHint?: string;
  type?: "simple" | "sop";
  systemPrompt?: string;
  steps?: SopStep[];
  tools?: string[];
  mcpServers?: string[];
  skills?: string[];
  workspacePolicy?: WorkspacePolicy;
  /** 并发槽；> 1 时 workspacePolicy 必须是 per-task / per-run（导入时由 validateAgentProfile 复核） */
  maxParallel?: number;
  /** 员工级默认审查者；属于团队协作关系，因此随配置分享。 */
  reviewer?: string;
  retro?: { enabled: boolean; distill?: string[]; exclude?: string[] };
  routeFallback?: boolean;
  manualOnly?: boolean;
  stream?: boolean;
  paramsSchema?: Record<string, string>;
}

export interface PortableSkill {
  name: string;
  description: string;
  /** 完整 SKILL.md；导出前已做本机路径和已知凭据替换。 */
  raw: string;
}

export interface PortableMcp {
  name: string;
  scope: McpScope;
  decl: {
    type: "stdio" | "sse" | "http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
  /** 导入后需要在接收方本机完成的绑定；包内永远没有值。 */
  requiredBindings: Array<{
    placeholder: string;
    kind: "secret" | "path";
    target: "env" | "header" | "command" | "arg" | "url";
    key?: string;
    index?: number;
  }>;
}

export interface TeamBundlePayload {
  meta: {
    id: string;
    name: string;
    description?: string;
    createdAt: string;
    sourceVersion?: string;
  };
  scope: {
    kind: "full" | "employees" | "custom";
    includeBoss: boolean;
    requestedAgents?: string[];
  };
  boss?: BossPersona;
  agents: PortableAgent[];
  skills: PortableSkill[];
  mcps: PortableMcp[];
  dependencies: {
    builtinAgents: string[];
    builtinSkills: string[];
    builtinMcps: string[];
  };
  security: {
    excluded: string[];
    warnings: string[];
  };
}

export interface TeamBundleEnvelope {
  format: typeof TEAM_BUNDLE_FORMAT;
  version: typeof TEAM_BUNDLE_VERSION;
  payload: TeamBundlePayload;
  integrity: { algorithm: "sha256"; digest: string };
}

export type TeamImportMode = "add_employees" | "merge" | "replace_team";
export type ConflictAction = "keep" | "replace" | "rename";

export interface TeamImportPlan {
  mode: TeamImportMode;
  includeBoss: boolean;
  selectedAgents: string[];
  selectedSkills: string[];
  selectedMcps: string[];
  agentConflicts: Record<string, { action: ConflictAction; targetId?: string }>;
  skillConflicts: Record<string, { action: Exclude<ConflictAction, "rename"> }>;
  mcpConflicts: Record<string, { action: Exclude<ConflictAction, "rename"> }>;
}

export interface TeamImportInspection {
  bundle: TeamBundleEnvelope;
  compatible: boolean;
  errors: string[];
  warnings: string[];
  conflicts: {
    agents: string[];
    skills: string[];
    mcps: string[];
  };
  missingDependencies: {
    builtinAgents: string[];
    builtinSkills: string[];
    builtinMcps: string[];
  };
  requiredBindings: PortableMcp["requiredBindings"];
  defaultPlans: Record<TeamImportMode, TeamImportPlan>;
}

export interface TeamSnapshotMeta {
  id: string;
  createdAt: string;
  reason: string;
  importBundleId?: string;
}

export interface TeamApplyResult {
  snapshotId: string;
  addedAgents: string[];
  updatedAgents: string[];
  skippedAgents: string[];
  pendingMcpBindings: string[];
  warnings: string[];
}
