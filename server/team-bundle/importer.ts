import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  getBuiltinAgentIds,
} from "../agents/registry.js";
import {
  hiredProfilePath,
  listHiredProfiles,
  saveHiredProfile,
  validateAgentProfile,
  clearAgentProfileCache,
  type AgentProfile,
} from "../config/agent-profile.js";
import { config } from "../config/index.js";
import {
  saveMcpServer,
  deleteMcpServer,
  type McpServerDecl,
} from "../config/mcp-store.js";
import { atomicWriteWithBackup, writeBossOverlay } from "../config/settings-store.js";
import { listSkills, saveSkill, userSkillExists } from "../core/skill-store.js";
import { listMcpServers } from "../core/mcp.js";
import { taskManager as tm } from "../boss/task-manager.js";
import {
  diffLocalBindings,
  snapshotLocalBindings,
  LOCAL_AGENT_FIELDS,
} from "./local-guard.js";
import type {
  PortableAgent,
  PortableMcp,
  TeamApplyResult,
  TeamBundleEnvelope,
  TeamImportInspection,
  TeamImportMode,
  TeamImportPlan,
  TeamSnapshotMeta,
} from "./types.js";

interface SnapshotManifest extends TeamSnapshotMeta {
  present: { boss: boolean; agents: boolean; skills: boolean; mcp: boolean };
}

const SNAPSHOT_KEEP = 10;

function teamStateRoot(): string {
  return join(config.runtimeDir, "team-bundles");
}

function snapshotsRoot(): string {
  return join(teamStateRoot(), "snapshots");
}

function userSkillsRoot(): string {
  return join(config.userPluginsDir, "skills");
}

function snapshotDir(id: string): string {
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id)) throw new Error("snapshotId 非法");
  return join(snapshotsRoot(), id);
}

function copyIfPresent(source: string, target: string): boolean {
  if (!existsSync(source)) return false;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  return true;
}

export function createTeamSnapshot(reason: string, importBundleId?: string): TeamSnapshotMeta {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const dir = snapshotDir(id);
  mkdirSync(dir, { recursive: true });
  const manifest: SnapshotManifest = {
    id,
    createdAt: new Date().toISOString(),
    reason,
    ...(importBundleId ? { importBundleId } : {}),
    present: {
      boss: copyIfPresent(join(config.runtimeDir, "boss.json"), join(dir, "boss.json")),
      agents: copyIfPresent(config.hiredAgentsDir, join(dir, "agents")),
      skills: copyIfPresent(userSkillsRoot(), join(dir, "skills")),
      mcp: copyIfPresent(config.userMcpFile, join(dir, "mcp.servers.json")),
    },
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  pruneSnapshots();
  return { id, createdAt: manifest.createdAt, reason, ...(importBundleId ? { importBundleId } : {}) };
}

function pruneSnapshots(): void {
  if (!existsSync(snapshotsRoot())) return;
  const dirs = readdirSync(snapshotsRoot()).sort();
  for (const stale of dirs.slice(0, Math.max(0, dirs.length - SNAPSHOT_KEEP))) {
    rmSync(join(snapshotsRoot(), stale), { recursive: true, force: true });
  }
}

export function listTeamSnapshots(): TeamSnapshotMeta[] {
  if (!existsSync(snapshotsRoot())) return [];
  const out: TeamSnapshotMeta[] = [];
  for (const id of readdirSync(snapshotsRoot()).sort().reverse()) {
    try {
      const raw = JSON.parse(readFileSync(join(snapshotDir(id), "manifest.json"), "utf-8")) as SnapshotManifest;
      out.push({ id: raw.id, createdAt: raw.createdAt, reason: raw.reason, ...(raw.importBundleId ? { importBundleId: raw.importBundleId } : {}) });
    } catch {
      // 损坏快照不进入可回滚清单
    }
  }
  return out;
}

function replaceFromSnapshot(
  present: boolean,
  source: string,
  target: string,
): void {
  rmSync(target, { recursive: true, force: true });
  if (present) copyIfPresent(source, target);
}

export function restoreTeamSnapshot(id: string): void {
  const dir = snapshotDir(id);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as SnapshotManifest;
  replaceFromSnapshot(manifest.present.boss, join(dir, "boss.json"), join(config.runtimeDir, "boss.json"));
  replaceFromSnapshot(manifest.present.agents, join(dir, "agents"), config.hiredAgentsDir);
  replaceFromSnapshot(manifest.present.skills, join(dir, "skills"), userSkillsRoot());
  replaceFromSnapshot(manifest.present.mcp, join(dir, "mcp.servers.json"), config.userMcpFile);
  clearAgentProfileCache();
}

export function createDefaultImportPlan(
  bundle: TeamBundleEnvelope,
  mode: TeamImportMode,
  agentIds = bundle.payload.agents.map((a) => a.id),
): TeamImportPlan {
  const conflicts = inspectConflicts(bundle);
  const conflictAction = mode === "replace_team" ? "replace" : "keep";
  return {
    mode,
    includeBoss: mode === "add_employees" ? false : Boolean(bundle.payload.boss),
    selectedAgents: agentIds,
    selectedSkills: mode === "add_employees"
      ? dependencySkillNames(bundle, agentIds)
      : bundle.payload.skills.map((s) => s.name),
    selectedMcps: mode === "add_employees"
      ? dependencyMcpNames(bundle, agentIds)
      : bundle.payload.mcps.map((m) => m.name),
    agentConflicts: Object.fromEntries(conflicts.agents.map((id) => [id, { action: conflictAction }])),
    skillConflicts: Object.fromEntries(conflicts.skills.map((id) => [id, { action: conflictAction }])),
    mcpConflicts: Object.fromEntries(conflicts.mcps.map((id) => [id, { action: conflictAction }])),
  };
}

function inspectConflicts(bundle: TeamBundleEnvelope) {
  const hired = new Set(listHiredProfiles().map((a) => a.id));
  const skills = new Set(listSkills().filter((s) => s.source === "user").map((s) => s.name));
  const mcps = new Set(listMcpServers().filter((m) => m.source === "user").map((m) => m.name));
  return {
    agents: bundle.payload.agents.map((a) => a.id).filter((id) => hired.has(id)),
    skills: bundle.payload.skills.map((s) => s.name).filter((id) => skills.has(id)),
    mcps: bundle.payload.mcps.map((m) => m.name).filter((id) => mcps.has(id)),
  };
}

function normalizedSkillRef(ref: string): string {
  return ref.replace(/^(?:user|builtin):/, "");
}

function dependencySkillNames(bundle: TeamBundleEnvelope, agentIds: string[]): string[] {
  const available = new Set(bundle.payload.skills.map((s) => s.name));
  const names = new Set<string>();
  for (const agent of bundle.payload.agents) {
    if (!agentIds.includes(agent.id)) continue;
    for (const ref of agent.skills ?? []) {
      const name = normalizedSkillRef(ref);
      if (available.has(name)) names.add(name);
    }
  }
  return [...names];
}

function dependencyMcpNames(bundle: TeamBundleEnvelope, agentIds: string[]): string[] {
  const available = new Set(bundle.payload.mcps.map((m) => m.name));
  const names = new Set<string>();
  for (const mcp of bundle.payload.mcps) if (mcp.scope === "global") names.add(mcp.name);
  for (const agent of bundle.payload.agents) {
    if (!agentIds.includes(agent.id)) continue;
    for (const name of agent.mcpServers ?? []) if (available.has(name)) names.add(name);
    for (const tool of agent.tools ?? []) {
      const name = tool.match(/^mcp__([^_]+(?:[_-][^_]+)*)/)?.[1];
      if (name && available.has(name)) names.add(name);
    }
  }
  return [...names];
}

export function inspectTeamBundle(bundle: TeamBundleEnvelope): TeamImportInspection {
  const errors: string[] = [];
  const warnings = [...bundle.payload.security.warnings];
  const builtinAgents = new Set(getBuiltinAgentIds());
  const localSkills = new Set(listSkills().filter((s) => s.source === "builtin").map((s) => s.name));
  const localMcps = new Set(listMcpServers().filter((m) => m.source === "builtin").map((m) => m.name));
  const bundledAgentIds = new Set(bundle.payload.agents.map((a) => a.id));
  for (const agent of bundle.payload.agents) {
    if (builtinAgents.has(agent.id)) errors.push(`员工 ${agent.id} 与接收方内置岗位冲突，禁止覆盖`);
    const errs = validateAgentProfile(agent as AgentProfile, true);
    if (errs.length) errors.push(`员工 ${agent.id} 配置非法：${errs.join("；")}`);
    if (agent.reviewer && !bundledAgentIds.has(agent.reviewer) && !builtinAgents.has(agent.reviewer)) {
      warnings.push(`员工 ${agent.id} 的默认审查者 ${agent.reviewer} 未包含在配置中`);
    }
    for (const step of agent.steps ?? []) {
      for (const target of [step.delegate, step.reviewer]) {
        if (target && !bundledAgentIds.has(target) && !builtinAgents.has(target)) {
          warnings.push(`员工 ${agent.id} 的 SOP 引用了未包含的员工 ${target}`);
        }
      }
    }
  }
  const missingDependencies = {
    builtinAgents: bundle.payload.dependencies.builtinAgents.filter((id) => !builtinAgents.has(id)),
    builtinSkills: bundle.payload.dependencies.builtinSkills.filter((id) => !localSkills.has(id)),
    builtinMcps: bundle.payload.dependencies.builtinMcps.filter((id) => !localMcps.has(id)),
  };
  if (missingDependencies.builtinAgents.length) warnings.push(`缺少内置员工：${missingDependencies.builtinAgents.join(", ")}`);
  if (missingDependencies.builtinSkills.length) warnings.push(`缺少内置 Skill：${missingDependencies.builtinSkills.join(", ")}`);
  if (missingDependencies.builtinMcps.length) warnings.push(`缺少内置 MCP：${missingDependencies.builtinMcps.join(", ")}`);
  const conflicts = inspectConflicts(bundle);
  return {
    bundle,
    compatible: errors.length === 0,
    errors,
    warnings: [...new Set(warnings)],
    conflicts,
    missingDependencies,
    requiredBindings: bundle.payload.mcps.flatMap((m) => m.requiredBindings),
    defaultPlans: {
      add_employees: createDefaultImportPlan(bundle, "add_employees"),
      merge: createDefaultImportPlan(bundle, "merge"),
      replace_team: createDefaultImportPlan(bundle, "replace_team"),
    },
  };
}

function validatePlan(bundle: TeamBundleEnvelope, plan: TeamImportPlan): void {
  const agentIds = new Set(bundle.payload.agents.map((a) => a.id));
  const skillIds = new Set(bundle.payload.skills.map((s) => s.name));
  const mcpIds = new Set(bundle.payload.mcps.map((m) => m.name));
  for (const id of plan.selectedAgents) if (!agentIds.has(id)) throw new Error(`导入计划引用了包外员工 ${id}`);
  for (const id of plan.selectedSkills) if (!skillIds.has(id)) throw new Error(`导入计划引用了包外 Skill ${id}`);
  for (const id of plan.selectedMcps) if (!mcpIds.has(id)) throw new Error(`导入计划引用了包外 MCP ${id}`);
  if (plan.includeBoss && !bundle.payload.boss) throw new Error("导入计划要求 Boss，但团队包不包含 Boss");
  for (const [id, conflict] of Object.entries(plan.agentConflicts)) {
    if (conflict.action === "rename" && !/^[a-z][a-z0-9_-]{1,39}$/.test(conflict.targetId ?? "")) {
      throw new Error(`员工 ${id} 的重命名目标非法`);
    }
  }
}

function preserveLocalAgentFields(imported: AgentProfile, local: AgentProfile | undefined): AgentProfile {
  if (!local) return imported;
  const out = { ...imported } as AgentProfile;
  for (const key of LOCAL_AGENT_FIELDS) {
    const value = local[key];
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = structuredClone(value);
  }
  return out;
}

function rewriteAgent(agent: PortableAgent, mapping: Map<string, string>): AgentProfile {
  const id = mapping.get(agent.id) ?? agent.id;
  return {
    ...structuredClone(agent),
    id,
    ...(agent.reviewer ? { reviewer: mapping.get(agent.reviewer) ?? agent.reviewer } : {}),
    type: agent.type ?? "simple",
    ...(agent.steps
      ? {
          steps: agent.steps.map((s) => ({
            ...s,
            ...(s.delegate ? { delegate: mapping.get(s.delegate) ?? s.delegate } : {}),
            ...(s.reviewer ? { reviewer: mapping.get(s.reviewer) ?? s.reviewer } : {}),
          })),
        }
      : {}),
    createdAt: new Date().toISOString(),
    createdBy: "team-import",
  } as AgentProfile;
}

function parseSkill(raw: string): { description: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md 缺少合法 frontmatter");
  const description = match[1].match(/^description:\s*["']?([^\n"']+)["']?$/m)?.[1]?.trim();
  if (!description) throw new Error("SKILL.md 缺少 description");
  return { description, body: match[2].trim() };
}

function currentUserMcp(name: string): McpServerDecl | undefined {
  return listMcpServers().find((m) => m.name === name && m.source === "user")?.decl as McpServerDecl | undefined;
}

/** replace 时只复用接收方本地绑定值，不复用导出方的结构。 */
function bindMcpDecl(mcp: PortableMcp, local: McpServerDecl | undefined): { decl: McpServerDecl; pending: string[] } {
  const decl = structuredClone(mcp.decl) as McpServerDecl;
  const pending: string[] = [];
  for (const binding of mcp.requiredBindings) {
    let value: string | undefined;
    if (binding.target === "env" && binding.key) value = local?.env?.[binding.key];
    else if (binding.target === "header" && binding.key) value = local?.headers?.[binding.key];
    else if (binding.target === "command") value = local?.command;
    else if (binding.target === "arg" && binding.index != null) value = local?.args?.[binding.index];
    else if (binding.target === "url" && binding.key && local?.url) {
      try { value = new URL(local.url).searchParams.get(binding.key) ?? undefined; } catch { /* ignore */ }
    }
    if (!value || /^\$\{[A-Z][A-Z0-9_]+\}$/.test(value)) {
      pending.push(binding.placeholder);
      continue;
    }
    if (binding.target === "env" && binding.key) decl.env = { ...decl.env, [binding.key]: value };
    else if (binding.target === "header" && binding.key) decl.headers = { ...decl.headers, [binding.key]: value };
    else if (binding.target === "command") decl.command = value;
    else if (binding.target === "arg" && binding.index != null && decl.args) decl.args[binding.index] = value;
    else if (binding.target === "url" && binding.key && decl.url) {
      try { const url = new URL(decl.url); url.searchParams.set(binding.key, value); decl.url = url.toString(); } catch { /* keep placeholder */ }
    }
  }
  return { decl, pending };
}

export function applyTeamImport(bundle: TeamBundleEnvelope, plan: TeamImportPlan): TeamApplyResult {
  const inspection = inspectTeamBundle(bundle);
  if (!inspection.compatible) throw new Error(`团队包不可导入：${inspection.errors.join("；")}`);
  validatePlan(bundle, plan);

  const selectedAgents = bundle.payload.agents.filter((a) => plan.selectedAgents.includes(a.id));
  const replaceIds = selectedAgents
    .filter((a) => plan.agentConflicts[a.id]?.action === "replace" || plan.mode === "replace_team")
    .map((a) => a.id);
  const affected = new Set(plan.mode === "replace_team" ? listHiredProfiles().map((a) => a.id) : replaceIds);
  const busy = tm.allActiveTasks().filter((t) => affected.has(t.agentName));
  if (busy.length) throw new Error(`这些员工还有活跃任务，不能覆盖：${[...new Set(busy.map((t) => t.agentName))].join(", ")}`);

  const snapshot = createTeamSnapshot(`导入团队：${bundle.payload.meta.name}`, bundle.payload.meta.id);
  // 落地自检的基线。放在建快照之后：万一自检判违规要走回滚，回滚目标就是这一刻的状态
  const localBefore = snapshotLocalBindings();
  const addedAgents: string[] = [];
  const updatedAgents: string[] = [];
  const skippedAgents: string[] = [];
  const pending = new Set<string>();
  const warnings = [...inspection.warnings];
  try {
    const existing = new Map(listHiredProfiles().map((a) => [a.id, a]));
    const builtin = new Set(getBuiltinAgentIds());
    const mapping = new Map<string, string>();
    for (const agent of selectedAgents) {
      const conflict = plan.agentConflicts[agent.id];
      if (conflict?.action === "rename") mapping.set(agent.id, conflict.targetId!);
      else mapping.set(agent.id, agent.id);
    }

    if (plan.mode === "replace_team") {
      const keep = new Set(selectedAgents.map((a) => mapping.get(a.id) ?? a.id));
      for (const local of listHiredProfiles()) {
        if (!keep.has(local.id)) rmSync(hiredProfilePath(local.id), { force: true });
      }
    }

    const localHasFallback = listHiredProfiles().some((a) => a.routeFallback && !affected.has(a.id));
    for (const portable of selectedAgents) {
      const targetId = mapping.get(portable.id) ?? portable.id;
      if (builtin.has(targetId)) throw new Error(`员工 ${targetId} 与内置岗位冲突`);
      const conflict = plan.agentConflicts[portable.id];
      if (existing.has(portable.id) && (!conflict || conflict.action === "keep") && plan.mode !== "replace_team") {
        skippedAgents.push(portable.id);
        continue;
      }
      let profile = rewriteAgent(portable, mapping);
      if (localHasFallback && profile.routeFallback) {
        profile.routeFallback = false;
        warnings.push(`员工 ${profile.id} 的路由兜底已关闭：本地已有兜底岗位`);
      }
      profile = preserveLocalAgentFields(profile, existing.get(targetId));
      saveHiredProfile(profile);
      if (existing.has(targetId)) updatedAgents.push(targetId);
      else addedAgents.push(targetId);
    }

    const selectedSkills = bundle.payload.skills.filter((s) => plan.selectedSkills.includes(s.name));
    if (plan.mode === "replace_team") {
      const keep = new Set(selectedSkills.map((s) => s.name));
      for (const skill of listSkills().filter((s) => s.source === "user")) {
        if (!keep.has(skill.name)) rmSync(join(userSkillsRoot(), skill.name), { recursive: true, force: true });
      }
    }
    for (const skill of selectedSkills) {
      const conflict = plan.skillConflicts[skill.name];
      if (userSkillExists(skill.name) && conflict?.action !== "replace" && plan.mode !== "replace_team") continue;
      const parsed = parseSkill(skill.raw);
      saveSkill({ name: skill.name, description: parsed.description, body: parsed.body });
    }

    const selectedMcps = bundle.payload.mcps.filter((m) => plan.selectedMcps.includes(m.name));
    if (plan.mode === "replace_team") {
      const keep = new Set(selectedMcps.map((m) => m.name));
      for (const mcp of listMcpServers().filter((m) => m.source === "user")) {
        if (!keep.has(mcp.name)) deleteMcpServer(mcp.name);
      }
    }
    for (const mcp of selectedMcps) {
      const conflict = plan.mcpConflicts[mcp.name];
      const local = currentUserMcp(mcp.name);
      if (local && conflict?.action !== "replace" && plan.mode !== "replace_team") continue;
      const bound = bindMcpDecl(mcp, local);
      bound.pending.forEach((name) => pending.add(name));
      saveMcpServer({ name: mcp.name, scope: mcp.scope, decl: bound.decl });
    }

    if (plan.includeBoss && bundle.payload.boss) {
      const persona = structuredClone(bundle.payload.boss);
      if (persona.employees) {
        persona.employees = Object.fromEntries(
          Object.entries(persona.employees).map(([id, name]) => [mapping.get(id) ?? id, name]),
        );
      }
      writeBossOverlay(persona as unknown as Record<string, unknown>);
    }
    /**
     * 落地自检：本机运行绑定一个字节都不该被导入改动。
     * 这里**不是**复查上面那些代码写对了没，而是防「将来 AgentProfile 新增一个本机字段、
     * 但没人往 LOCAL_AGENT_FIELDS 里加」——那种漏保护不会报错，只会让某个员工悄悄换了模型。
     * 判违规就抛，交给下面的 catch 走自动回滚。
     */
    const violations = diffLocalBindings(localBefore, snapshotLocalBindings());
    if (violations.length > 0) {
      throw new Error(
        `导入试图改动本机模型/凭据绑定，已回滚：${violations.join("；")}`,
      );
    }

    return {
      snapshotId: snapshot.id,
      addedAgents,
      updatedAgents,
      skippedAgents,
      pendingMcpBindings: [...pending].sort(),
      warnings: [...new Set(warnings)],
    };
  } catch (error) {
    try {
      restoreTeamSnapshot(snapshot.id);
    } catch (rollbackError) {
      throw new Error(
        `导入失败且自动回滚失败：${error instanceof Error ? error.message : error}；回滚错误：${rollbackError instanceof Error ? rollbackError.message : rollbackError}`,
      );
    }
    throw error;
  }
}
