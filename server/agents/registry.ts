import type { BaseAgent } from "./base-agent.js";
import {
  isTempProfile,
  listBuiltinProfiles,
  listHiredProfiles,
  type AgentProfile,
} from "../config/agent-profile.js";
import { OptimizerAgent } from "./builtin/optimizer.agent.js";
import { RetroAgent } from "./builtin/retro.agent.js";
import { HrAgent } from "./builtin/hr.agent.js";
import { ToolerAgent } from "./builtin/tooler.agent.js";
import { LeadAgent } from "./builtin/lead.agent.js";
import { ConfigAgent } from "./declarative/config-agent.js";
import { ConfigWorkflowAgent } from "./declarative/config-workflow-agent.js";

export const DEFAULT_AGENT_NAME = "default";

/**
 * 一个岗位 = server/config/agents/<id>.json（声明）+ 可选的 builtin/<id>.agent.ts（代码行为）。
 * 只有需要自定义门禁（sdkGuards）/ 动态提示词 / 覆写 run 的岗位才在这里登记类，
 * 其余纯声明岗位自动由 ConfigAgent 承载（如 alert-diagnosis）。
 */
const BUILTIN_CLASSES: Record<string, () => BaseAgent> = {
  optimizer: () => new OptimizerAgent(),
  retro: () => new RetroAgent(),
  hr: () => new HrAgent(),
  tooler: () => new ToolerAgent(),
  lead: () => new LeadAgent(),
};

/** 内置岗位实例（建一次即复用；声明项由 profile getter 实时读取，改 JSON 即时生效） */
const builtins = new Map<string, BaseAgent>();
/** 招聘员工实例（随配置目录热加载） */
const hired = new Map<string, BaseAgent>();

function instantiate(profile: AgentProfile): BaseAgent {
  const factory = BUILTIN_CLASSES[profile.id];
  if (factory) return factory();
  return profile.type === "sop"
    ? new ConfigWorkflowAgent(profile.id)
    : new ConfigAgent(profile.id);
}

/** 同步两个配置目录 → 实例表；配置读取带 mtime 缓存，未变更时开销可忽略 */
function sync(): void {
  const seen = new Set<string>();
  for (const profile of listBuiltinProfiles()) {
    seen.add(profile.id);
    if (!builtins.has(profile.id)) builtins.set(profile.id, instantiate(profile));
  }
  for (const id of [...builtins.keys()]) if (!seen.has(id)) builtins.delete(id);

  hired.clear();
  // includeTemp：临时工必须能被 getAgent 解析（绑定任务派发、/cancel、看板详情都走它），
  // 对路由的不可见性由 listAgents / listRoutableAgents 负责
  for (const profile of listHiredProfiles({ includeTemp: true })) {
    if (seen.has(profile.id)) continue; // 招聘配置不得覆盖内置岗位
    hired.set(profile.id, instantiate(profile));
  }
}

/** 全部 agent（内置 + 招聘） */
function allAgents(): BaseAgent[] {
  sync();
  return [...builtins.values(), ...hired.values()];
}

/** 临时工：只对绑定任务开放，不进任何名册/候选集 */
function isTempAgent(a: BaseAgent): boolean {
  return isTempProfile(a.profile);
}

export function getAgent(name: string): BaseAgent | undefined {
  sync();
  return builtins.get(name) ?? hired.get(name);
}

export function listAgents() {
  return allAgents()
    .filter((a) => !isTempAgent(a))
    .map(({ name, displayName, description, routeHint }) => ({
      name,
      ...(displayName ? { displayName } : {}),
      description,
      // 路由职责卡（【选我当】/【别选我当】）：HR 招新员工时据此划边界，避免职责重叠
      ...(routeHint ? { routeHint } : {}),
    }));
}

/**
 * 路由候选：全部 agent 对全部渠道可见（不需要渠道配置），
 * 排除 profile.manualOnly 的岗位（复盘 / 提示词优化）与临时工。
 *
 * 临时工必须在**这里**排除而不是只从工具的 description 里藏掉：这个数组同时喂给
 * routeAgent、clarify 重路由和改派候选，藏 description 等于什么都没做。
 */
export function listRoutableAgents(): BaseAgent[] {
  return allAgents().filter((a) => !a.manualOnly && !isTempAgent(a));
}

/** 临时工实例（清理器 / 绑定任务派发用） */
export function listTempAgents(): BaseAgent[] {
  return allAgents().filter(isTempAgent);
}

/** 内置岗位 id 集合（招聘时校验 id 不得撞内置） */
export function getBuiltinAgentIds(): string[] {
  sync();
  return [...builtins.keys()];
}

export function isBuiltinId(id: string): boolean {
  return getBuiltinAgentIds().includes(id);
}
