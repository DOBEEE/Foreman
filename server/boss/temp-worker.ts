import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config/index.js";
import {
  expandPathTokens,
  hiredProfileExists,
  hiredProfilePath,
  isTempProfile,
  listHiredProfiles,
  resolveWorkspace,
  saveHiredProfile,
  validateAgentProfile,
  type AgentProfile,
  type SopStep,
  type TempMeta,
} from "../config/agent-profile.js";
import { isHighPrivTool, READONLY_TOOLS } from "../tools/catalog.js";
import { SENSITIVE_PATTERNS } from "../core/audit.js";
import { memoryDirOf } from "../core/memory.js";
import { getBuiltinAgentIds } from "../agents/registry.js";
import { taskManager as tm } from "./task-manager.js";
import { interruptRun } from "./inflight.js";
import { pruneLedger, recordRelease } from "./temp-ledger.js";

/**
 * 临时工：boss 遇到「没人会干这活」时现招的一次性执行者。
 *
 * 为什么是真实 profile 文件而不是内存对象（对比 agents/squad/ephemeral.ts）：
 * 他要占员工槽位、要有会话能续跑、要能被 /cancel、要在看板上看得见。
 * 编队里的 EphemeralAgent 刻意一个都没有，补齐就是把 profile 重新发明一遍。
 *
 * **用完即释放，别攒**：live 群体只有当前在跑的，攒不起来的东西不会泛滥——
 * 这比任何配额都硬。通用性不在招人那一刻靠模型硬猜，而是交给 hr 从台账里归纳
 * （见 temp-ledger.ts）：同一能力域反复出现才值得设一个正式岗位。
 */

/**
 * 临时工步数额度：他是「名册里没人能干」的唯一兜底执行者，额度要对得起真活儿——
 * 参照同僚（assistant 15 / code-review 40 / coder 80，全局缺省 50）。
 * 带写权限的活要「改 → 跑 → 看结果 → 再改」，给得更高。
 * 具体一次给多少由招聘方按这件活的实际规模指定（见 HireInput.maxTurns），这里只是缺省值。
 */
const MAX_TURNS_READONLY = 30;
const MAX_TURNS_WRITE = 60;
/** 硬上限：按任务调配也不该越过全局闸，越过了只会被上层截断，不如在这里说清 */
const MAX_TURNS_CEILING = 80;

function ttlMs(): number {
  return config.tempWorker.ttlHours * 3600 * 1000;
}

export interface HireInput {
  /** 能力域：如「CSV / 表格类数据的汇总与整理」。这是给复盘聚类用的键 */
  capability: string;
  /** 招他来干的那件事（简报原文） */
  hiredFor: string;
  /** 职责描述 */
  description: string;
  systemPrompt: string;
  hiredBy: "boss" | "hr";
  /** 绑定任务：只有这个任务能派给他 */
  taskId: string;
  chatId: string;
  /** 工具白名单；不给则只读。含 Write/Edit/Bash 等高权限工具时必须同时给 readRoots */
  tools?: string[];
  /** 他能**读**的真实目录（写始终只限自己的工作目录，见 §权限边界） */
  readRoots?: string[];
  /** hr 招人时可给：SOP 步骤、模型 */
  steps?: SopStep[];
  model?: string;
  /** 按这件活的实际规模给的步数额度；不给则按有无写权限取缺省（30 / 60），上限 80 */
  maxTurns?: number;
}

export type HireResult =
  | { ok: true; id: string; displayName: string }
  | { ok: false; reason: string };

/**
 * 不许声明为可读根的目录：凭据与服务自身的家当。
 * 这几条不是「不方便」，是「给了就等于把钥匙一起给了」。
 *
 * 粒度是刻意区分的：
 * - `runtimeDir` 整棵禁（前缀匹配）——里面有 secrets.json 与全部员工配置，
 *   包括「与内置岗位同名即成为权限覆盖层」这个提权入口。
 * - `serviceRoot` 只禁它**本身**（精确匹配）。整棵禁会误伤 `knowledge/`、`plugins/`
 *   这些本来就是给员工读的目录；而真正的机密（.env / .git / logs）已由
 *   SENSITIVE_PATTERNS 在门禁那层逐文件拦掉。
 */
function forbiddenRoot(dir: string): string | undefined {
  const home = process.env.HOME ?? "";
  if (dir === "/" || dir === home) return "不能把整个磁盘或整个家目录声明为可读范围";
  if (dir === config.serviceRoot) return `不能把服务根目录整个声明进来（${config.serviceRoot}）`;
  if (dir.startsWith(config.runtimeDir)) return `不能声明服务运行时目录（${config.runtimeDir}）——里面有凭据与员工配置`;
  if (SENSITIVE_PATTERNS.some((p) => p.test(dir))) return "命中凭据 / 密钥 / 日志类敏感路径";
  return undefined;
}

/** 按任务调配步数额度：招聘方给了就用（夹进上限），给了非法值就当没给 */
function resolveMaxTurns(requested: number | undefined, canWrite: boolean): number {
  const fallback = canWrite ? MAX_TURNS_WRITE : MAX_TURNS_READONLY;
  if (requested == null || !Number.isInteger(requested) || requested < 10) return fallback;
  return Math.min(requested, MAX_TURNS_CEILING);
}

/** 能力域归一化键：代码按它精确分组算次数（近义写法的合并留给 hr 语义判断） */
export function capabilitySlug(capability: string): string {
  return capability
    .toLowerCase()
    .replace(/[\s_/\\.]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

/** 全部在岗临时工 */
export function listTempProfiles(): AgentProfile[] {
  return listHiredProfiles({ includeTemp: true }).filter(isTempProfile);
}

function tempIdFor(capability: string): string {
  const slug = capabilitySlug(capability) || "worker";
  // id 必须是 ^[a-z][a-z0-9_-]{1,39}$，中文 slug 过不了 → 退回随机后缀
  const ascii = slug.replace(/[^a-z0-9-]/g, "");
  const base = ascii.length >= 2 ? ascii : "worker";
  return `tmp-${base}-${randomBytes(2).toString("hex")}`.slice(0, 40);
}

/**
 * 招一个临时工。
 *
 * 三道闸门：
 * - **每任务 1 个**：一件活不该冒出两个人。
 * - **同会话同能力域、且那人手上已经没活**：让调用方续派给他，别开新会话重查一遍。
 * - **live 上限**：防失控循环的保险丝，不是主机制。
 *
 * 刻意**不**按 capabilitySlug 跨时间拒绝：同类需求隔几天再出现不是错误，正是归纳要的信号。
 * 拒绝并不减少需求，只是让需求落空。
 */
export function hireTempWorker(input: HireInput): HireResult {
  const slug = capabilitySlug(input.capability);
  const existing = listTempProfiles();

  if (existing.some((p) => p.temp?.taskId === input.taskId)) {
    return { ok: false, reason: `任务 #${input.taskId} 已经有一位临时工了，不必再招——让他接着做。` };
  }
  /**
   * 同会话、同能力域、且**手上的活已经收尾**（人闲着）→ 拒招，让调用方去续派。
   *
   * 拦的正是「一件活分两阶段，第一阶段交卷后第二阶段又招个新人」：新人是全新会话，
   * 上一阶段查到的东西全得重查一遍（实测烧过一轮 token）。
   *
   * **他还在忙则放行**：同一会话里并行两件同类活是正当需求，拦下来第二件就干不了。
   *
   * 与下面「刻意不按 capabilitySlug 拒绝」不矛盾——那条说的是**跨时间**的重复需求
   * （同类需求反复出现正是建岗信号，拒绝只会让需求落空）；这里只拦「人就在旁边闲着」
   * 这一种当场就能省掉的浪费。
   */
  const idleSameCap = existing.find((p) => {
    if (p.temp?.chatId !== input.chatId || p.temp?.capabilitySlug !== slug) return false;
    // 「闲着」要两个条件同时成立：招他来干的那件活已收尾，且名下没有任何活跃任务——
    // 续派会给他建新任务，而那时 temp.taskId 仍指着旧的那件，只看它会把在忙的人误判成闲着
    const bound = tm.get(p.temp.chatId, p.temp.taskId);
    const boundSettled = bound
      ? ["done", "failed", "cancelled"].includes(bound.state)
      : false;
    return boundSettled && tm.allActiveTasks().every((t) => t.agentName !== p.id);
  });
  if (idleSameCap) {
    return {
      ok: false,
      reason:
        `本会话已有在岗临时工「${idleSameCap.displayName ?? idleSameCap.id}」（续派名 ${idleSameCap.id}，` +
        `能力域相同，手上的活已收尾）。用 continue_task 续派给他本人——` +
        `他的会话里有上一轮的全部数据；重招是全新会话，同样的活要重查一遍。`,
    };
  }
  if (existing.length >= config.tempWorker.maxLive) {
    return {
      ok: false,
      reason:
        `同时在岗的临时工已达上限 ${config.tempWorker.maxLive} 位（${existing.map((p) => p.id).join("、")}）。` +
        `等他们做完释放（最多 ${config.tempWorker.ttlHours} 小时）再招，或先取消其中一个任务。`,
    };
  }

  const id = tempIdFor(input.capability);
  if (hiredProfileExists(id) || getBuiltinAgentIds().includes(id)) {
    return { ok: false, reason: `员工 id 冲突（${id}），请重试。` };
  }

  /**
   * 权限边界（代码判定，不靠提示词）：
   * - 工具不给则只读。要 Write/Edit/Bash 就**必须**同时声明本次要碰的目录 readRoots，
   *   门禁只在声明后才启用——不要求它，「按需授权」就等于「无限授权」。
   * - **写始终只限他自己的 per-run 工作目录 + 笔记目录**（base-agent 的通用规则）。
   *   readRoots 决定他能**读**哪些真实目录。要改真实仓库就在工作目录里 clone、
   *   改完 push 工作分支（主干由 branch guard 挡），不在原地改用户的工作树。
   */
  const tools = input.tools?.length ? [...new Set(input.tools)] : [...READONLY_TOOLS];
  const highPriv = tools.filter(isHighPrivTool);
  const readRoots: string[] = [];
  for (const raw of input.readRoots ?? []) {
    const dir = expandPathTokens(raw);
    const bad = forbiddenRoot(dir);
    if (bad) return { ok: false, reason: `可读目录「${raw}」不被接受：${bad}。` };
    readRoots.push(dir);
  }
  if (highPriv.length > 0 && readRoots.length === 0) {
    return {
      ok: false,
      reason:
        `要给他 ${highPriv.join(" / ")} 就必须同时声明 readRoots（这次要碰哪些目录）——` +
        `不声明的话文件门禁不会启用，等于给了无限范围。要么补上目录，要么只给只读工具。`,
    };
  }

  const temp: TempMeta = {
    capability: input.capability,
    hiredFor: input.hiredFor,
    hiredBy: input.hiredBy,
    capabilitySlug: slug,
    taskId: input.taskId,
    chatId: input.chatId,
    lastUsedAt: Date.now(),
  };

  const profile: AgentProfile = {
    id,
    displayName: `临时·${input.capability}`.slice(0, 24),
    description: input.description,
    // 不给 routeHint：临时工不进路由候选，写了也没人看；
    // 而一份高度具体的 routeHint 恰恰是误路由的源头（见 registry.listRoutableAgents）
    type: input.steps?.length ? "sop" : "simple",
    systemPrompt: input.systemPrompt,
    ...(input.steps?.length ? { steps: input.steps } : {}),
    tools,
    ...(readRoots.length > 0 ? { readRoots } : {}),
    maxTurns: resolveMaxTurns(input.maxTurns, highPriv.length > 0),
    ...(input.model ? { model: input.model } : {}),
    workspace: "auto",
    workspacePolicy: "per-run",
    // 不参与复盘：经验留给会被释放的人没有意义。他对团队记忆的贡献是那条台账记录
    retro: { enabled: false },
    temp,
    createdAt: new Date().toISOString(),
    createdBy: input.hiredBy,
  };

  const errs = validateAgentProfile(profile, true);
  if (errs.length > 0) return { ok: false, reason: `临时工配置非法：${errs.join("; ")}` };

  saveHiredProfile(profile);
  return { ok: true, id, displayName: profile.displayName ?? id };
}

/**
 * 从归档复活一个已释放的临时工。
 *
 * 唯一使用场景：用户重试一个 failed 任务，而它的临时工已被 TTL sweep 释放归档。
 * failed 是终态，sweepTempWorkers 不把它当活跃任务，临时工闲置超 TTL 即被清走——
 * 之后 runWorker 拿不到 agent 只能判「员工不存在」，这条失败任务就永久无法重试。
 * 归档文件保留了完整 profile（含 systemPrompt），据它还原回名册即可继续原任务。
 *
 * 只还原 profile 本身：per-run 工作目录与经验库目录在释放时已删，靠不上——
 * 但重试本就走「会话丢失则按原始需求从头执行」的兜底，per-run 目录本就每轮新建。
 *
 * 幂等：id 还在名册里就直接返回 ok（没被清，无需复活）。
 */
export function reviveTempWorker(agentName: string): { ok: boolean; reason?: string } {
  if (hiredProfileExists(agentName)) return { ok: true };
  if (getBuiltinAgentIds().includes(agentName)) {
    return { ok: false, reason: `${agentName} 是内置岗位，不该走复活` };
  }
  const dir = config.agentsArchiveDir;
  if (!existsSync(dir)) return { ok: false, reason: "没有归档目录" };
  // 归档命名 `${id}-${epochMs}.json`；同一 id 可能复活再归档多次，取时间戳最大的那份
  const prefix = `${agentName}-`;
  const latest = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => ({ f, ts: Number(f.slice(prefix.length, -".json".length)) || 0 }))
    .sort((a, b) => b.ts - a.ts)[0];
  if (!latest) return { ok: false, reason: `归档里找不到 ${agentName} 的存档` };

  let profile: AgentProfile;
  try {
    profile = JSON.parse(readFileSync(join(dir, latest.f), "utf-8")) as AgentProfile;
  } catch {
    return { ok: false, reason: `归档文件 ${latest.f} 读取失败` };
  }
  // 只复活临时工存档：正式岗位的归档另有语义，不走这条路径
  if (!profile.temp) return { ok: false, reason: `${agentName} 不是临时工存档，拒绝复活` };

  // TTL 锚点归零到现在，避免刚复活又被同一轮 sweep 判过期
  profile.temp.lastUsedAt = Date.now();

  const errs = validateAgentProfile(profile, true);
  if (errs.length > 0) return { ok: false, reason: `存档配置非法：${errs.join("; ")}` };

  saveHiredProfile(profile);
  return { ok: true };
}

/** 刷新活跃时间（每次派发/续跑时调）。TTL 锚在这里而非创建时间 */
export function touchTempWorker(agentName: string): void {
  const profile = readTemp(agentName);
  if (!profile?.temp) return;
  profile.temp.lastUsedAt = Date.now();
  saveHiredProfile(profile);
}

function readTemp(agentName: string): AgentProfile | undefined {
  const found = listTempProfiles().find((p) => p.id === agentName);
  return found ? { ...found } : undefined;
}

/**
 * 释放：**唯一删除收口**。打断在跑的 run → 取消名下任务 → 归档 spec → 记台账
 * → 删档 → 清工作目录与经验库目录。
 *
 * 归档必须在这里而不是在调用方：systemPrompt 只存在于 profile 文件里（从不进日志），
 * 任何一条不经归档的删除路径都会把它永久销毁，而它正是 hr 归纳时最需要的素材。
 */
export function releaseTempWorker(agentName: string): { ok: boolean; cancelled: string[] } {
  const profile = readTemp(agentName);
  if (!profile) return { ok: false, cancelled: [] };

  const cancelled: string[] = [];
  for (const task of tm.allActiveTasks().filter((t) => t.agentName === agentName)) {
    if (task.state === "running") interruptRun(task.chatId, task.id);
    if (tm.cancel(task.chatId, task.id)) cancelled.push(task.id);
  }

  const meta = profile.temp;
  const archivedSpec = archive(profile);
  if (meta) {
    // 任务快照要含已终态的那个（效果指标全在它身上），所以按 (chatId, taskId) 直取
    const task = tm.get(meta.chatId, meta.taskId);
    recordRelease({
      tempId: profile.id,
      capability: meta.capability,
      capabilitySlug: meta.capabilitySlug,
      hiredFor: meta.hiredFor,
      taskId: meta.taskId,
      chatId: meta.chatId,
      hiredBy: meta.hiredBy,
      ...(archivedSpec ? { archivedSpec } : {}),
      ...(task ? { task } : {}),
    });
  }
  rmDir(resolveWorkspace(profile));
  rmDir(memoryDirOf(agentName));
  return { ok: true, cancelled };
}

function rmDir(dir: string): void {
  if (!dir || !existsSync(dir)) return;
  // 兜一层保险：只删 runtimeDir 底下的目录，避免配置写歪把别处删了
  if (!dir.startsWith(config.runtimeDir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清不掉不影响主流程 */
  }
}

/**
 * 到期清理。返回被释放的 id。
 *
 * **有活跃任务的一律跳过**：删掉后 advanceEmployee → dequeueNext → getAgent 拿到
 * undefined，会报「员工不存在」把排队任务打死。看板删员工也有同一道判断。
 */
export function sweepTempWorkers(now = Date.now()): string[] {
  const removed: string[] = [];
  const ttl = ttlMs();
  for (const profile of listTempProfiles()) {
    const meta = profile.temp;
    if (!meta) continue;
    if (now - meta.lastUsedAt < ttl) continue;
    if (tm.allActiveTasks().some((t) => t.agentName === profile.id)) continue;
    releaseTempWorker(profile.id);
    removed.push(profile.id);
  }
  if (removed.length > 0) console.log(`[temp] 释放到期临时工 ${removed.length} 位：${removed.join(", ")}`);
  // 剪枝要跟着台账走：归档文件只在对应记录被清掉后才删，不能先于记录消失
  for (const spec of pruneLedger(now)) {
    try {
      if (existsSync(spec)) rmSync(spec);
    } catch {
      /* 清不掉不影响主流程 */
    }
  }
  return removed;
}

function archiveDir(): string {
  mkdirSync(config.agentsArchiveDir, { recursive: true });
  return config.agentsArchiveDir;
}

/** 归档 profile 文件，返回归档路径。台账存这个路径 → hr 归纳时能回看当时那份提示词 */
function archive(profile: AgentProfile): string | undefined {
  const from = hiredProfilePath(profile.id);
  if (!existsSync(from)) return undefined;
  const to = join(archiveDir(), `${profile.id}-${Date.now()}.json`);
  try {
    renameSync(from, to);
    return to;
  } catch (error) {
    // 归档失败也必须让 profile 消失，否则一个已释放的人还留在名册里接活
    console.warn(`[temp] 归档 ${profile.id} 失败，直接删档:`, error);
    try {
      unlinkSync(from);
    } catch {
      /* 已不在就算了 */
    }
    return undefined;
  }
}
