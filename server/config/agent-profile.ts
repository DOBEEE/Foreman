import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./index.js";
import { builtinAgentsDir } from "./paths.js";

/**
 * SOP 步骤：小组长按序执行的一步。
 * - mode=self：小组长自己做，prompt 为本步指令模板
 * - mode=delegate：委派给 delegate 指定的员工，accept 声明验收标准（不达标带反馈重试）
 * 模板占位：{{input}}、{{param.xxx}}、{{step:<前序id>}}、{{step:<id>.<field>}}
 */
export interface SopStep {
  id: string;
  title: string;
  mode?: "self" | "delegate";
  prompt: string;
  delegate?: string;
  /** 评审人员工 id：产出后由他真跑一轮评审，不过则执行者带意见重做 */
  reviewer?: string;
  /** 验收标准：有 reviewer 给评审人用；无 reviewer 时组长轻量判定；都留空不验收 */
  accept?: string;
  /** 验收不过的最大重试次数，默认 2 */
  maxRetries?: number;
  maxTurns?: number;
  /** 产出合约：声明本步必须产出的文件和/或结构化数据字段 */
  produces?: { files?: string[]; data?: Record<string, string> };
  /** 依赖的上游步骤 id 列表：启动前校验上游合约，运行中可通过 reject_upstream 反馈 */
  needs?: string[];
}

/**
 * 工作目录策略：shared 共享 / per-chat 按会话分桶持久 / per-task 按任务分桶持久 / per-run 用完即弃。
 *
 * `per-task` 与 `per-run` 的区别是**跨轮存活**，这决定了谁能开并发：
 * per-run 目录在每次 run 的 finally 里被删掉，而一个任务通常跨多个 run
 * （问用户 → run 结束 → 用户回答 → 新 run），第二个 run 会面对空目录，clone 和分支全没了。
 * 所以要让「有写能力、要留现场」的岗位并行，只能用 per-task。
 */
export type WorkspacePolicy = "shared" | "per-chat" | "per-task" | "per-run";

/**
 * agent 专属声明式配置（一个岗位一个 JSON），两个来源共用同一份 schema：
 * - server/config/agents/<id>.json —— 内置岗位（进 git，代码里只留行为，声明项全在这）
 * - <runtimeDir>/agents/<id>.json —— HR 招聘的配置员工（运行时私有，可热改）
 * 只有「代码行为」（自定义 hook、动态提示词拼装、覆写 run）才留在 .agent.ts 里。
 */
export interface AgentProfile {
  /** 唯一身份 id（slug）：既是路由名也是文件名 */
  id: string;
  /** 拟人化展示名（如「小码」），boss 播报与点名路由用 */
  displayName?: string;
  /** 头像：单个 emoji 或图片 URL（缺省用 dashboard 内置默认头像） */
  avatar?: string;
  /** 一句话职责：路由 + dashboard 展示 */
  description?: string;
  /** 路由职责卡（【选我当】/【别选我当】），缺省用 description */
  routeHint?: string;
  /**
   * 实现形态：
   * - builtin：由 server/agents/builtin/<id>.agent.ts 提供行为（本配置只补声明项）
   * - simple：纯配置单轮 agent
   * - sop：固定流程小组长（按 steps 执行、可委派下属并验收）
   */
  type?: "builtin" | "simple" | "sop";
  /** 系统提示词正文（simple/sop 用；与 systemPromptFile 二选一） */
  systemPrompt?: string;
  /** 长提示词文件名（server/agents/prompts/ 下的 md），优先于 systemPrompt */
  systemPromptFile?: string;
  /** type=sop 的步骤清单 */
  steps?: SopStep[];

  /** 覆盖全局 model */
  model?: string;
  /**
   * 覆盖全局 `qoder.model`，**仅在 `--runtime=qoder` 下生效**。
   *
   * 与 `model` 并存而不是复用它：Qoder 的模型标识是自己的档位/别名
   * （`auto` / `ultimate` / `lite` / `qmodel_38max` …），与 Anthropic 模型名不通用。
   * 分成两个字段，切 runtime 时两套配置各自保留、互不破坏。
   * 典型用法：复盘这类每天跑的岗位配 `lite`（0x 倍率）省额度，coder 配 `ultimate`。
   */
  qoderModel?: string;
  /**
   * 按员工独立的模型供应商与凭据（引用 providers.json 的一项）：
   * - id：供应商 id；缺省则继承全局默认（config.defaultProviderId → .env 兜底）
   * - model：行内覆盖模型（优先级高于 profile.model）
   * - baseUrl：行内覆盖网关地址
   * 整段不设 = 完全走全局默认。key 不落在这里，统一在 secrets.json（按 provider id 取）。
   */
  provider?: { id?: string; model?: string; baseUrl?: string };
  /**
   * 该岗位模型的上下文窗口（token）。仅用于自动压缩阈值判定：
   * 大窗口（≥ config.compact.minWindow）才把压缩阈值主动压到 60%，小窗口交给 SDK 默认行为。
   */
  contextWindow?: number;
  /**
   * Prompt cache 保留档位（不设 = short）。
   * - short：5 分钟，Anthropic 默认。写入 1.25x。**绝大多数岗位用它就够**——
   *   缓存收益主要来自一次 run 内的多步工具循环，步与步间隔秒级。
   * - long：1 小时，写入 2x。只给「一小时内确实会被 resume」的常驻岗位（如 coder）。
   *   定时岗位（复盘/优化员，间隔 24 小时~7 天）不要设 long：跨 run 复用永远等不到，纯亏写入费。
   */
  cacheRetention?: "short" | "long";
  /** 覆盖全局 maxTurns */
  maxTurns?: number;
  /** extended thinking 额度；不设置则不启用 */
  maxThinkingTokens?: number;
  /** 工具白名单（不设置 = 全部工具可用）；MCP 工具写 mcp__<server> 或 mcp__<server>__<tool> */
  tools?: string[];
  /** 点名挂载 server/config/mcp.servers.json 的 optionalServers（全局 mcpServers 无需声明） */
  mcpServers?: string[];
  /** 预载 skill 名单（plugin skills 用 <plugin>:<name>） */
  skills?: string[];

  /**
   * 工作目录：
   * - 缺省 / "auto" → <runtimeDir>/workspaces/<id>
   * - 支持占位：${serviceRoot} ${runtimeDir} ${workingDir} ${knowledgeDir}
   * - 其余按绝对/相对路径解析
   */
  workspace?: string;
  workspacePolicy?: WorkspacePolicy;
  /**
   * 同一 chat 内该员工可同时进行的任务数（并发槽），缺省 1 = 串行，与历史行为一致。
   *
   * 排队最常见的成因其实是员工停下来**等用户回答**（`OCCUPYING_STATES` 含 `waiting_user`），
   * 一等，同 chat 后面所有派给他的任务全卡住；而全局并发闸 `maxConcurrentRuns` 远没吃满。
   *
   * `> 1` 时**强制要求 workspacePolicy 是 per-task / per-run**：两个 run 同时改同一个
   * 工作树会互相踩踏（一边切分支一边改文件），而且会稳定触发「看到对方的脏改动就停下来
   * 问用户」。这条校验刻意**不**复用 `needsSerialRun()`——那个判据里 MUTATING_TOOLS 含 Bash，
   * 而几乎每个岗位都有 Bash，走它等于谁都开不了。
   */
  maxParallel?: number;
  /**
   * 只读根白名单（声明即启用文件访问门禁）：所有带路径的工具只许访问这些目录
   * （+ 本次 run 工作目录），且凭据/密钥/日志类敏感文件一律拦截。
   * 支持 ${knowledgeDir} 等占位；特殊值 "${codeRoots}" 展开为公共配置的 codeRoots 列表。
   */
  readRoots?: string[];

  /** 是否参与每日复盘沉淀 */
  retro?: { enabled: boolean; distill?: string[]; exclude?: string[] };

  /**
   * 提示词冻结：该岗位的 systemPrompt 不接受提示词优化提案。
   *
   * 给评测师这类岗位用。仅靠「内置岗位」不足以冻结——内置岗位允许用户覆盖层
   * （本就是用来开工具权限的），而覆盖层一存在 `hiredProfileExists` 就为真，
   * 提案就能落到它头上。裁判的提示词可被改写，等于没有裁判。
   */
  promptFrozen?: boolean;

  /**
   * 该岗位的产出默认由谁验收（员工 id）。语义对齐编队里的 `step.reviewer`。
   *
   * **判据是「产出是不是可评审工件」，不是「有没有写权限」**：实测 10 个岗位里 9 个都有
   * Write/Bash，按写权限判会给 tooler、retro 也配上评审员——但 tooler 装完 MCP 该验的是
   * 「工具能不能调通」（属于产出合约硬查），retro 的产出是经验库（硬查 + 人审已够）。
   * `lead` 更不该配：它内部 `step.reviewer` 已经有一层，外面再套是双重评审。
   * 目前只有改代码的岗位（coder / default）适合配。
   *
   * **不填是绝大多数岗位的正解**：此时降级为「合约硬校验 + 主管协议闸」，不派验收员。
   * 结论类产出（答疑、告警定位）没有可独立评审的工件，派评审员只是重复协议闸已做过的
   * 文本判断，却要付一整个 agent run。
   */
  reviewer?: string;

  /** 路由兜底岗位（LLM 分类失败/无候选时选它），全局限一个 */
  routeFallback?: boolean;
  /** 仅手动触发，不参与自动路由（复盘、提示词优化等） */
  manualOnly?: boolean;
  /** HTTP 默认响应模式：true=SSE 流式（默认），false=一次性 JSON */
  stream?: boolean;
  /** 需要路由器从用户输入中提取的业务入参（key → 含义） */
  paramsSchema?: Record<string, string>;

  /** 审计元信息 */
  createdAt?: string;
  createdBy?: string;
  /**
   * 临时工标记。临时工是**真实 profile 文件**（要占员工槽位、有会话、可 /cancel、
   * 看板可见），但对路由**永不可见**——见 listHiredProfiles / listRoutableAgents。
   * 只对绑定的那个任务开放，否则一个刚写好的高度具体的 routeHint 会把无关新活
   * 吸到一个即将被释放的临时工身上。
   */
  temp?: TempMeta;
  /** 加载时注入：配置来源（builtin=仓库内置，hired=HR 招聘） */
  source?: "builtin" | "hired";
}

export interface TempMeta {
  /** 能力域（招人时必填）：如「CSV / 表格类数据的汇总与整理」。归纳聚类的语义源 */
  capability: string;
  /** 招他来干的那件事（简报） */
  hiredFor: string;
  hiredBy: "boss" | "hr";
  /** 能力域的归一化键：代码按它精确分组算次数，近义合并留给 hr */
  capabilitySlug: string;
  /**
   * 绑定的任务：只有这个任务能派给他。
   * 保持单数——任务结束后 ~2h 就释放，跨任务复用无从发生。
   */
  taskId: string;
  /** 绑定任务所在会话（释放时按 (chatId, taskId) 直接取任务快照） */
  chatId: string;
  /** TTL 锚点（不用创建时间：还在被用的人不该被清掉） */
  lastUsedAt: number;
}

/**
 * 临时工：**永远**对路由不可见、永不转正。
 * 归纳出来的正式岗位是新 id 的新员工（多个临时工的合并），不继承其中任何一个的身份。
 */
export function isTempProfile(profile: Pick<AgentProfile, "temp">): boolean {
  return Boolean(profile.temp);
}

const ID_RE = /^[a-z][a-z0-9_-]{1,39}$/;
const WS_POLICIES = new Set<WorkspacePolicy>(["shared", "per-chat", "per-task", "per-run"]);
const DEFAULT_DISTILL = [
  "可复用的做法与约定",
  "踩过的坑与规避办法",
  "被用户纠正的判断与正确做法",
];

/** 工作目录占位表：配置里写 ${runtimeDir} 之类，避免把机器路径写死进 JSON */
function pathTokens(): Record<string, string> {
  return {
    serviceRoot: config.serviceRoot,
    runtimeDir: config.runtimeDir,
    workingDir: config.workingDir,
    knowledgeDir: config.knowledgeDir,
    workspacesRoot: config.workspacesRoot,
    hiredAgentsDir: config.hiredAgentsDir,
    agentsArchiveDir: config.agentsArchiveDir,
  };
}

/** 展开路径占位符（${runtimeDir} 等）并解析为绝对路径 */
export function expandPathTokens(raw: string): string {
  const tokens = pathTokens();
  return resolve(raw.replace(/\$\{(\w+)\}/g, (all, key: string) => tokens[key] ?? all));
}

/** 解析岗位工作目录基址（未声明 → <runtimeDir>/workspaces/<id>） */
export function resolveWorkspace(profile: AgentProfile): string {
  const raw = profile.workspace;
  if (!raw || raw === "auto") return join(config.workspacesRoot, profile.id);
  return expandPathTokens(raw);
}

/** 解析只读根白名单（未声明返回 undefined = 不启用门禁） */
export function resolveReadRoots(profile: AgentProfile): string[] | undefined {
  if (!profile.readRoots?.length) return undefined;
  const out: string[] = [];
  for (const raw of profile.readRoots) {
    if (raw === "${codeRoots}") out.push(...config.codeRoots);
    else out.push(expandPathTokens(raw));
  }
  return out;
}

/** 由配置生成复盘沉淀规则；未开启返回 undefined */
export function profileRetroSpec(
  profile: AgentProfile,
): { enabled: boolean; distill: string[]; exclude?: string[] } | undefined {
  if (!profile.retro?.enabled) return undefined;
  return {
    enabled: true,
    distill: profile.retro.distill?.length ? profile.retro.distill : DEFAULT_DISTILL,
    ...(profile.retro.exclude ? { exclude: profile.retro.exclude } : {}),
  };
}

/**
 * 校验配置，返回错误信息数组（空 = 合法）。
 * strict=true 用于 HR 招聘的配置员工：必须自带 description + systemPrompt（无代码兜底）。
 */
export function validateAgentProfile(
  profile: Partial<AgentProfile>,
  strict = false,
): string[] {
  const errs: string[] = [];
  if (typeof profile.id !== "string" || !ID_RE.test(profile.id))
    errs.push("id 非法：需 2-40 位小写字母开头的 slug（字母/数字/-/_）");
  if (strict) {
    if (typeof profile.displayName !== "string" || !profile.displayName.trim())
      errs.push("displayName 不能为空");
    if (typeof profile.description !== "string" || !profile.description.trim())
      errs.push("description 不能为空");
    if (profile.temp) {
      // 临时工不进路由（listRoutableAgents 结构性排除），职责卡对它没有意义，
      // 写了反而会招来误路由。这里反向禁止，顺手把设计不变量钉住。
      // 曾经漏了这个分支：strict 一律要求 routeHint，把临时工整条招聘路径判成非法，
      // 功能整体失效而没有任何报错线索（只在 hire 的返回值里说「配置非法」）。
      if (profile.routeHint != null)
        errs.push("临时工不得声明 routeHint（不进路由，写了只会招来误路由）");
    } else if (
      typeof profile.routeHint !== "string" ||
      !profile.routeHint.includes("【选我当】") ||
      !profile.routeHint.includes("【别选我当】")
    ) {
      errs.push("routeHint 必须包含【选我当】与【别选我当】两段");
    }
    if (typeof profile.systemPrompt !== "string" || !profile.systemPrompt.trim())
      errs.push("systemPrompt 不能为空");
  }
  if (profile.tools != null && !Array.isArray(profile.tools))
    errs.push("tools 必须是数组");
  // 「reviewer 必须指向存在的员工」在 hr-tools 的 validateEmployeeRefs 里校验——
  // 本文件拿不到注册表（会成环）。这里只做不依赖注册表的结构校验。
  if (profile.reviewer != null) {
    if (typeof profile.reviewer !== "string" || !profile.reviewer.trim())
      errs.push("reviewer 不能是空值，不需要评审就整个字段别写");
    else if (profile.reviewer === profile.id)
      errs.push("reviewer 不能是自己（自己评自己的活没有意义，对齐编队里评审人不得与执行者相同）");
  }
  if (profile.maxThinkingTokens != null && typeof profile.maxThinkingTokens !== "number")
    errs.push("maxThinkingTokens 必须是数字");
  if (profile.workspacePolicy != null && !WS_POLICIES.has(profile.workspacePolicy))
    errs.push("workspacePolicy 只能是 shared / per-chat / per-task / per-run");
  if (profile.maxParallel != null) {
    if (!Number.isInteger(profile.maxParallel) || profile.maxParallel < 1) {
      errs.push("maxParallel（影分身）必须是 >= 1 的整数（1 = 不开分身，不需要就整个字段别写）");
    } else if (profile.maxParallel > config.maxConcurrentRuns) {
      // 配了个比全局闸还大的数字只会让人误判实际并发度，不如直接拒绝
      errs.push(
        `maxParallel（影分身）不能超过全局并发上限 ${config.maxConcurrentRuns}（config.maxConcurrentRuns）——` +
          `再大也会被全局闸挡住，等于配了个假数字`,
      );
    } else if (
      profile.maxParallel > 1 &&
      profile.workspacePolicy !== "per-task" &&
      profile.workspacePolicy !== "per-run"
    ) {
      errs.push(
        `要开影分身（maxParallel > 1）就必须把 workspacePolicy 设成 per-task 或 per-run，当前是 ` +
          `${profile.workspacePolicy ?? "shared"}——每个分身得有自己的工作目录，` +
          `两个分身同时改一棵工作树会互相踩踏。要留现场（clone / 分支）就用 per-task，用完即弃才用 per-run`,
      );
    }
  }
  if (profile.type === "sop") {
    if (!Array.isArray(profile.steps) || profile.steps.length === 0)
      errs.push("type=sop 必须提供非空 steps");
    else {
      const ids = new Set<string>();
      for (const [i, s] of profile.steps.entries()) {
        const at = `steps[${i}]`;
        if (!s || typeof s.id !== "string" || !s.id.trim())
          errs.push(`${at}.id 不能为空`);
        else if (ids.has(s.id)) errs.push(`${at}.id 重复：${s.id}`);
        else ids.add(s.id);
        if (typeof s?.title !== "string" || !s.title.trim())
          errs.push(`${at}.title 不能为空`);
        if (typeof s?.prompt !== "string" || !s.prompt.trim())
          errs.push(`${at}.prompt 不能为空`);
        if (s?.mode === "delegate" && (typeof s.delegate !== "string" || !s.delegate.trim()))
          errs.push(`${at} 是 delegate 步骤但未指定 delegate（受派员工 id）`);
        // 临时工不得再套临时工：嵌套出来的执行者没人追踪、没人清理
        if (profile.temp && (s?.delegate === "temp" || s?.reviewer === "temp"))
          errs.push(`${at} 临时工的 SOP 步骤不得再委派临时工（delegate/reviewer 不能是 temp）`);
        if (s?.reviewer != null && (typeof s.reviewer !== "string" || !s.reviewer.trim()))
          errs.push(`${at}.reviewer 必须是员工 id`);
      }
    }
  }
  return errs;
}

interface Cached {
  mtimeMs: number;
  profile: AgentProfile;
}
/** 按文件路径缓存已解析配置，靠 mtime 判定是否重读（改配置即时生效，无需重启） */
const cache = new Map<string, Cached>();

/** 团队快照整目录恢复后调用：文件可能被批量替换，逐项 mtime 缓存不再可信。 */
export function clearAgentProfileCache(): void {
  cache.clear();
}

function readProfileFile(
  path: string,
  source: "builtin" | "hired",
  strict = source === "hired",
): AgentProfile | undefined {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.profile;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AgentProfile>;
    const errs = validateAgentProfile(parsed, strict);
    if (errs.length > 0) {
      console.warn(`[agents] 跳过非法配置 ${path}: ${errs.join("; ")}`);
      return undefined;
    }
    const profile = { ...parsed, source } as AgentProfile;
    cache.set(path, { mtimeMs, profile });
    return profile;
  } catch (error) {
    console.warn(`[agents] 读取配置 ${path} 失败:`, error);
    return undefined;
  }
}

function listDir(dir: string, source: "builtin" | "hired"): AgentProfile[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: AgentProfile[] = [];
  for (const file of files) {
    const profile = readProfileFile(join(dir, file), source);
    if (profile) out.push(profile);
  }
  return out;
}

/** 内置岗位配置（server/config/agents/*.json） */
export function listBuiltinProfiles(): AgentProfile[] {
  return listDir(builtinAgentsDir, "builtin");
}

/** 内置岗位 id 集合（按内置配置文件名，overlay 判定用） */
function builtinIdFiles(): Set<string> {
  try {
    return new Set(
      readdirSync(builtinAgentsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, "")),
    );
  } catch {
    return new Set();
  }
}

/**
 * HR 招聘的配置员工（<runtimeDir>/agents/*.json）。
 * 与内置岗位同名的文件是「权限覆盖层」而非独立员工，这里跳过（见 loadAgentProfile）。
 *
 * **默认排除临时工**（fail closed）：他们随时会被释放，不该出现在
 * 路由候选、复盘对象、提示词优化对象、hr 的职责边界参考里。需要全量的调用方
 * （registry 建实例、清理器、看板详情）显式传 includeTemp。
 */
export function listHiredProfiles(opts?: { includeTemp?: boolean }): AgentProfile[] {
  const builtinIds = builtinIdFiles();
  let files: string[] = [];
  try {
    files = readdirSync(config.hiredAgentsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: AgentProfile[] = [];
  for (const file of files) {
    if (builtinIds.has(file.replace(/\.json$/, ""))) continue; // overlay，非独立员工
    const profile = readProfileFile(join(config.hiredAgentsDir, file), "hired");
    if (!profile) continue;
    if (!opts?.includeTemp && isTempProfile(profile)) continue;
    out.push(profile);
  }
  return out;
}

/**
 * 单个岗位配置：
 * - 内置岗位：server/config/agents/<id>.json，若存在同名用户覆盖层
 *   （~/.foreman/agents/<id>.json，非严格校验）则**浅合并**，用户字段整体覆盖内置字段。
 *   用途：给内置员工开工具权限（mcpServers / tools / skills）而不改动 git 里的内置配置。
 *   注意数组是整字段替换——overlay 里必须写合并后的完整数组。
 * - 招聘员工：~/.foreman/agents/<id>.json 单独成岗。
 */
export function loadAgentProfile(id: string): AgentProfile | undefined {
  const builtinPath = join(builtinAgentsDir, `${id}.json`);
  const overlayPath = hiredProfilePath(id);
  if (existsSync(builtinPath)) {
    const builtin = readProfileFile(builtinPath, "builtin");
    if (!builtin) return undefined;
    if (existsSync(overlayPath)) {
      const overlay = readProfileFile(overlayPath, "builtin", false);
      if (overlay) return { ...builtin, ...overlay, id, source: "builtin" };
    }
    return builtin;
  }
  if (existsSync(overlayPath)) return readProfileFile(overlayPath, "hired");
  return undefined;
}

export function hiredProfilePath(id: string): string {
  return join(config.hiredAgentsDir, `${id}.json`);
}

export function hiredProfileExists(id: string): boolean {
  return existsSync(hiredProfilePath(id));
}

/** 写入/覆盖一个配置员工（HR / dashboard 用） */
export function saveHiredProfile(profile: AgentProfile): void {
  const errs = validateAgentProfile(profile, true);
  if (errs.length > 0) throw new Error(`员工配置非法：${errs.join("; ")}`);
  mkdirSync(config.hiredAgentsDir, { recursive: true });
  const path = hiredProfilePath(profile.id);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
  renameSync(temp, path);
  cache.delete(path);
}
