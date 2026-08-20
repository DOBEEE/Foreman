// 与 src/config/agent-profile.ts 保持结构一致的前端类型副本
// （前后端跨包类型共享需要额外 tsconfig 联动，这里选择手工镜像，字段变化时同步）

export type WorkspacePolicy = "shared" | "per-chat" | "per-task" | "per-run";

export interface SopStep {
  id: string;
  title: string;
  mode?: "self" | "delegate";
  prompt: string;
  delegate?: string;
  accept?: string;
  maxRetries?: number;
  maxTurns?: number;
}

/** 临时工元信息（只出现在临时工身上；正式成员没有这一段） */
export interface TempMeta {
  /** 能力域：如「CSV / 表格类数据的汇总与整理」 */
  capability: string;
  /** 招他来干的那件活 */
  hiredFor: string;
  hiredBy: "boss" | "hr";
  /** 绑定任务：只有这个任务能派给他 */
  taskId: string;
  lastUsedAt: number;
  /** 到点即释放的时刻（毫秒时间戳） */
  expiresAt: number;
}

export interface AgentProfile {
  id: string;
  displayName: string;
  /** 头像：单个 emoji 或图片 URL */
  avatar?: string;
  description: string;
  routeHint?: string;
  type?: "simple" | "sop";
  systemPrompt: string;
  steps?: SopStep[];
  model?: string;
  /** Qoder 档位覆盖（仅 --runtime=qoder 生效）；与 model 是两套标识 */
  qoderModel?: string;
  /** 按员工独立的模型供应商（引用 providers.json）+ 行内覆盖；不设走全局默认 */
  provider?: { id?: string; model?: string; baseUrl?: string };
  maxThinkingTokens?: number;
  maxTurns?: number;
  tools?: string[];
  mcpServers?: string[];
  skills?: string[];
  workspace?: string;
  workspacePolicy?: WorkspacePolicy;
  /** 并发槽；> 1 时 workspacePolicy 必须是 per-task / per-run */
  maxParallel?: number;
  retro?: { enabled: boolean; distill?: string[]; exclude?: string[] };
  temp?: TempMeta;
  createdAt?: string;
  createdBy?: string;
}

export interface AgentMeta {
  id: string;
  /** 展示名（后端已回落到 id） */
  name: string;
  /** 自定义头像：emoji 或图片 URL（缺省用前端内置默认头像） */
  avatar?: string;
  /** exec=内置岗位（总裁办）/ staff=用户员工（预置 + 招聘） */
  group?: "exec" | "staff";
  description: string;
  routeHint?: string;
  type: "simple" | "sop" | "builtin";
  configurable: boolean;
  manualOnly?: boolean;
  tools?: string[];
  mcpServers?: string[];
  model?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
  workspacePolicy?: WorkspacePolicy;
  maxParallel?: number;
  steps?: SopStep[];
  retro?: { enabled: boolean; distill?: string[]; exclude?: string[] };
  temp?: TempMeta;
  createdAt?: string;
  createdBy?: string;
}

export interface BossNode {
  id: "__boss__";
  kind: "boss";
  name: string;
  avatar?: string;
  description: string;
}

export interface AgentNode extends AgentMeta {
  kind: "agent";
}

/** 在岗临时工：进组织图只为渲染，路由候选里永远没有他 */
export interface TempNode extends AgentMeta {
  kind: "temp";
}

export type TeamNode = BossNode | AgentNode | TempNode;

export interface TeamEdge {
  id: string;
  from: string;
  to: string;
  kind: "dispatch" | "delegate";
  stepId?: string;
  accept?: boolean;
  /** dispatch 边：true = 手动触发岗位（retro/optimizer），UI 用更弱化的样式 */
  manual?: boolean;
  /** dispatch 边：true = 指向临时工，只对其绑定任务成立，UI 走虚线 */
  temp?: boolean;
}

export interface TeamGraph {
  nodes: TeamNode[];
  edges: TeamEdge[];
}

/** 编队步骤执行记录（后端 StepOutcome） */
export interface SquadOutcome {
  id: string;
  title: string;
  employee: string;
  status: "done" | "failed";
  conclusion: string;
  attempts: number;
  /** 引擎侧重试原因（未交卷 / 合约缺失 / 评审打回），不是评审结论 */
  retryNotes?: string[];
  /** 每轮评审落档，通过的那次也记 */
  reviews?: Array<{
    reviewer: string;
    verdict: "pass" | "reject" | "inconclusive";
    conclusion?: string;
    feedback?: string;
    attempt: number;
  }>;
  /** 是否按协议调了 submit_step；组长自执行步为 undefined */
  submitted?: boolean;
  durationMs: number;
}

/** 编队计划步骤（后端 TeamStep） */
export interface SquadStep {
  id: string;
  title: string;
  employee: string;
  brief: string;
  reviewer?: string;
  accept?: string;
  maxRetries?: number;
  /** 前置依赖步骤 id：全部完成后本步才可开工（判定编队是否真在推进） */
  needs?: string[];
  temp?: { role: string; tools?: string[] };
}

/** 一个编队的实时状态（lead 的断点状态文件） */
export interface Squad {
  taskId: string;
  phase: "executing" | "wrapup";
  plan: { goal: string; acceptance?: string; steps: SquadStep[] };
  outcomes: SquadOutcome[];
  /**
   * 当前在跑的步骤。编队步骤不建 boss Task，任务列表里看不到成员在忙，
   * 所以「谁此刻在干活」只能由组长落盘告知。
   * 进程被打断时会残留，用之前必须校验组长任务本身还在 running。
   */
  running?: { stepId: string; employee: string; role: "exec" | "review"; startedAt: number };
}

/** 某员工在编队中的参与聚合（组织图的卡片徽标与连线共用） */
export interface SquadLink {
  exec: number;
  review: number;
  /** 正在进行的步骤（有则高亮 + 动画） */
  active?: { kind: "执行" | "评审"; title: string };
}

export interface ToolCatalog {
  readonly: string[];
  highPriv: string[];
  mcp: string[];
  /** 按需 MCP server 名（写进 profile.mcpServers 才挂载） */
  optional: string[];
}

export type TaskState =
  | "queued"
  | "running"
  | "waiting_user"
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  channel: string;
  chatId: string;
  chatType: "private" | "group";
  ownerSenderId: string;
  ownerSenderName: string;
  agentName: string;
  prompt: string;
  /** 主管派工简报（分诊时提炼的目标/验收），列表用它派生任务标题 */
  brief?: string;
  state: TaskState;
  sessionId?: string;
  question?: string;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatSummary {
  chatId: string;
  channel?: string;
  chatType?: "private" | "group";
  /** 人类可读的会话名（钉钉不提供群名，需手动命名） */
  title?: string;
  /** 最后一条消息预览 */
  lastText?: string;
  messageCount?: number;
  taskCount: number;
  activeCount: number;
  waitingCount: number;
  senders: string[];
  lastActivity: number;
}

/** 会话里的一条消息（服务端 <runtimeDir>/chats/<chat>.json） */
export interface ChatMessage {
  at: number;
  /** in=用户发来的，out=boss/员工回复的 */
  direction: "in" | "out";
  senderId?: string;
  senderName?: string;
  text: string;
  card?: string;
  error?: string;
}

/**
 * 主管的一次判断（服务端 logs/boss-<date>.jsonl 的一行）。
 * 员工的每一步都在 traces 里，主管的判断本来跑完就丢——这条流补上「为什么让他这么做」。
 */
export interface BossDecision {
  time: string;
  /** intent=分诊派工 / assist=代答或改派裁决 / review=验收 / direct=直答用户 / route=兜底路由 */
  kind: "intent" | "assist" | "review" | "feedback" | "route";
  summary: string;
  chatId?: string;
  /** 分诊与路由发生在任务创建之前，此时为空 */
  taskId?: string;
  agentName?: string;
  model: string;
  durationMs: number;
  isError?: boolean;
  promptTail: string;
  output: string;
}

// ─── 设置页（/settings） ────────────────────────────────
export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl?: string;
  authType: "auth_token" | "api_key";
  defaultModel?: string;
  createdAt?: string;
  createdBy?: string;
  /** 回显附加：是否已配密钥 + 掩码（永不回显明文） */
  hasSecret?: boolean;
  secretMask?: string;
}

export interface ProvidersResp {
  defaultProviderId: string;
  providers: ProviderInfo[];
}

/** 命名凭据槽位状态（渠道 / 搜索工具，只回存在性 + 掩码） */
export interface CredentialStatus {
  slot: string;
  envName: string;
  hasValue: boolean;
  mask: string;
  fromEnvFallback: boolean;
}

export interface CredentialsResp {
  credentials: CredentialStatus[];
  slots: string[];
}

export interface SettingsEffective {
  publicBaseUrl: string;
  model: string;
  routerModel: string;
  defaultProviderId: string;
  boss: { providerId: string; model: string };
  /** 当前进程的 LLM 执行后端（启动参数 --runtime 决定）。模型字段据此切换成下拉 */
  runtimeKind: "vercel" | "qoder";
  /** Qoder 专属配置（模型档位与上面的 model 是两套标识，互不通用） */
  qoder: {
    model: string;
    auth: {
      /** 缺省 qodercli = 同步本机 qodercli 登录态 */
      mode: "qodercli" | "accessToken" | "serviceAccount";
      /** 非空则从该环境变量取密钥，否则用服务端存的 */
      envVar: string;
      /** 只报有无，服务端绝不回显明文 */
      hasAccessToken: boolean;
      hasServiceAccount: boolean;
    };
  };
  maxTurns: number;
  maxAutoContinues: number;
  maxConcurrentRuns: number;
  memory: boolean;
  disabledTools: string[];
  dashboardAccess: "lan" | "localhost";
  port: number;
  assist: { enabled: boolean; maxSelfAnswers: number; maxReassigns: number };
  compact: {
    /** 上下文窗口（token）。压缩阈值按它折算；岗位可用 profile.contextWindow 覆盖 */
    contextWindow: number;
    /** 软阈值：到窗口的百分之多少且缓存已冷才压 */
    atPercent: number;
    /** 硬阈值：到这里无条件压 */
    hardAtPercent: number;
    minWindow: number;
  };
  dingtalk: { ack: boolean; ackDelayMs: number; clientId: string; robotCode: string };
  retro: { schedule: boolean; hour: number; notifyChat: string; notifyUser: string };
  optimizer: { schedule: boolean; weekday: number; hour: number; days: number };
  bench: { judgeProviderId: string; judgeModel: string };
  paths: {
    workingDir: string;
    knowledgeDir: string;
    pluginsDir: string;
    codeRoots: string[];
    runtimeDir: string;
  };
}

export interface SettingsResp {
  effective: SettingsEffective;
  overlayKeys: string[];
  restartRequired: string[];
  envCreds: { hasAuthToken: boolean; hasApiKey: boolean; baseUrl: string };
}

/** Qoder 一个可选模型档位（GET /api/console/qoder/models） */
export interface QoderModelOption {
  /** 传给 SDK options.model 的 id，如 auto / ultimate / qmodel_38max */
  value: string;
  displayName: string;
  description?: string;
  /** 服务端指定的默认档位 */
  isDefault?: boolean;
  /** 积分倍率，如 1.6 = 1.60x */
  priceFactor?: number;
  maxInputTokens?: number;
  isReasoning?: boolean;
  /** system=Qoder 目录 / user=BYOK / organization=组织内部 */
  source?: string;
}

export interface BossPersona {
  name: string;
  role: string;
  personality: string;
  style: string;
  team?: string;
  avatar?: string;
  employees?: Record<string, string>;
}

/** 人格预设：BossPersona + 选择器展示信息（server/config/boss-personas/*.json） */
export interface BossPersonaPreset extends BossPersona {
  id: string;
  label: string;
  blurb?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  model: string;
  ms: number;
  reply?: string;
  error?: string;
}

/** token 用量与缓存命中的一行（对应 server/core/cache-stats.ts 的 CacheStatsRow） */
export interface CacheStatsRow {
  /** 分组键：agent 维度是 agent 名，任务维度是 taskId */
  key: string;
  /** 展示名（任务维度是任务标题） */
  label: string;
  runs: number;
  /** 平均步数；与读写比几乎线性相关——缓存收益主要来自 run 内的多步工具循环 */
  avgSteps: number;
  /** 未命中·全价输入 */
  freshInput: number;
  /** 未命中·写入缓存 */
  cacheWrite: number;
  /** 命中·读缓存 */
  cacheRead: number;
  outputTokens: number;
  /** 输入合计 */
  totalInput: number;
  /** 未命中输入合计 = 全价 + 写 */
  missInput: number;
  /** 输入 + 输出 */
  totalTokens: number;
  hitRate: number;
  /** 低于 0.278 时缓存开始亏本 */
  readWriteRatio: number;
  /** 等效输入成本倍数：1.00 = 缓存完全没起作用 */
  costMultiple: number;
  savedPercent: number;
}

/** 任务维度的一行：额外带上参与的 agent */
export interface CacheTaskRow extends CacheStatsRow {
  agents: string[];
}

export interface CacheStats {
  days: number;
  totalRuns: number;
  agents: CacheStatsRow[];
  /** 按任务聚合，已按 token 合计降序截断 */
  tasks: CacheTaskRow[];
  /** 窗口内有用量记录的任务总数（tasks 被截断时用于提示） */
  taskCount: number;
  total: CacheStatsRow;
  /** 确认走 1h TTL 的写入占比；ttlSplitAvailable 为 false 时该值无意义 */
  ttl1hShare: number;
  /** 窗口内是否存在能拆 5m/1h 的日志（只有 Anthropic 原生形状的 usage 才带拆分） */
  ttlSplitAvailable: boolean;
}

// ─── 工具管理：MCP server ────────────────────────────────
export type McpScope = "global" | "optional";

export interface McpServerDecl {
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerEntry {
  name: string;
  /** global = 全员默认挂载；optional = 岗位点名才挂 */
  scope: McpScope;
  /** builtin 的只读（改 server/config/mcp.servers.json） */
  source: "builtin" | "user";
  /** 未展开的原始声明，含 ${VAR} 占位 */
  decl: McpServerDecl;
  /** 声明里引用了但当前环境没有的变量名。非空 = 这个 server 实际不会挂载 */
  missingEnv: string[];
  /** 哪些岗位点名了它 */
  refs: string[];
}

export interface McpServersResp {
  builtinFile: string;
  userFile: string;
  servers: McpServerEntry[];
}

// ─── 工具管理：Skill ────────────────────────────────────
export interface SkillEntry {
  name: string;
  description: string;
  /** 引用名 builtin:<name> / user:<name>，profile.skills 与 Skill 工具用它 */
  ref: string;
  source: "builtin" | "user";
  /** SKILL.md 正文字符数 */
  chars: number;
  /** 哪些岗位在 profile.skills 里声明了它（声明的会预载进 system） */
  declaredBy: string[];
}

export interface SkillsResp {
  builtinDir: string;
  userDir: string;
  skills: SkillEntry[];
}

/** 外部目录（其他 coding agent 装的 skill）里的可导入候选 */
export interface ExternalSkill {
  name: string;
  description: string;
  /** 源目录绝对路径 */
  dir: string;
  /** 来源根目录 */
  root: string;
  /** 用户侧已有同名 = 已导入过 */
  imported: boolean;
  /** SKILL.md 之外的附带文件/目录（我们不自动注入，仅提示） */
  extras: string[];
}

export interface ExternalSkillsResp {
  roots: string[];
  skills: ExternalSkill[];
}

// ─── 团队配置分享 ────────────────────────────────────────
export type TeamImportMode = "add_employees" | "merge" | "replace_team";
export interface TeamImportPlan {
  mode: TeamImportMode;
  includeBoss: boolean;
  selectedAgents: string[];
  selectedSkills: string[];
  selectedMcps: string[];
  agentConflicts: Record<string, { action: "keep" | "replace" | "rename"; targetId?: string }>;
  skillConflicts: Record<string, { action: "keep" | "replace" }>;
  mcpConflicts: Record<string, { action: "keep" | "replace" }>;
}

/** 会原样写进团队包的 MCP 公开常量（与后端 bundle.ts CarriedLiteral 对齐） */
export interface CarriedLiteral {
  mcp: string;
  target: "env" | "header" | "url" | "arg" | "command";
  key: string;
  value: string;
}

export interface TeamExportPreview {
  filename: string;
  meta: { id: string; name: string; description?: string; createdAt: string; sourceVersion?: string };
  scope: { kind: string; includeBoss: boolean; requestedAgents?: string[] };
  agents: Array<{ id: string; displayName?: string }>;
  skills: string[];
  mcps: Array<{ name: string; bindings: number }>;
  dependencies: { builtinAgents: string[]; builtinSkills: string[]; builtinMcps: string[] };
  security: { excluded: string[]; warnings: string[] };
  /**
   * 分级判定放行、会原样带出的值。**界面必须始终渲染这一段**（空也要显示 0 项）：
   * 只在非空时渲染的话，用户看不到清单时分不清「确实没有」和「界面漏了」。
   */
  carriedLiterals: CarriedLiteral[];
  compressedBytes: number;
}

export interface TeamImportView {
  record: { id: string; filename: string; status: string; plan: TeamImportPlan; result?: any; error?: string };
  inspection: {
    compatible: boolean;
    errors: string[];
    warnings: string[];
    conflicts: { agents: string[]; skills: string[]; mcps: string[] };
    requiredBindings: Array<{ placeholder: string; kind: "secret" | "path"; target: string }>;
    defaultPlans: Record<TeamImportMode, TeamImportPlan>;
    package: {
      meta: { id: string; name: string; description?: string; createdAt: string; sourceVersion?: string };
      boss?: { name: string; role: string };
      agents: Array<{ id: string; displayName?: string; description?: string }>;
      skills: Array<{ name: string; description: string }>;
      mcps: Array<{ name: string; scope: string; bindings: number }>;
      security: { excluded: string[]; warnings: string[] };
    };
  };
}

/** 投递目标异常种类。对应 server/api/schedule-routes.ts 的 TargetIssueKind */
export type TargetIssueKind =
  | "chat_unknown"
  | "chat_id_mismatch"
  | "owner_multi_chat"
  | "boss_blind";

export interface ScheduleTargetIssue {
  kind: TargetIssueKind;
  message: string;
}

/** 定时任务的投递目标（推到哪个会话）+ 归属异常判定 */
export interface ScheduleTarget {
  chatId: string;
  channel: string;
  chatType: "private" | "group";
  label: string;
  known: boolean;
  lastMessageAt?: number;
  messageCount?: number;
  siblings: Array<{ chatId: string; lastMessageAt: number; messageCount: number }>;
  issues: ScheduleTargetIssue[];
}

/** 对应 server/api/schedule-routes.ts 的 ScheduleEntry（手写镜像，不生成） */
export interface ScheduleEntry {
  id: string;
  title: string;
  prompt: string;
  agentName: string;
  agentLabel: string;
  agentMissing: boolean;
  timingText: string;
  enabled: boolean;
  disabledReason?: string;
  /** 已启用却仍残留停用原因（主管的 resume_schedule 不清该字段） */
  staleDisabledReason: boolean;
  running: boolean;
  lastTaskId?: string;
  backoffUntil?: number;
  backoffActive: boolean;
  runCount: number;
  skipCount: number;
  failCount: number;
  failuresToAutoDisable: number;
  lastRunAt?: number;
  dependsOn?: string;
  dependsOnLabel?: string;
  dependsOnMissing: boolean;
  dependents: Array<{ id: string; title: string }>;
  createdBy: string;
  createdAt: number;
  seedKey?: string;
  /** 内置任务：删了下次启动会被重新播种，正确关法是停用 */
  builtin: boolean;
  ownerSenderId: string;
  ownerSenderName: string;
  target: ScheduleTarget;
}

export interface ScheduleGroup {
  chatId: string;
  label: string;
  channel: string;
  chatType: "private" | "group";
  known: boolean;
  lastMessageAt?: number;
  issueKinds: TargetIssueKind[];
  schedules: ScheduleEntry[];
}

export interface SchedulesResp {
  /** 服务端时钟，避免客户端时钟偏差 */
  now: number;
  limits: { total: number; perAgent: number; maxConsecutiveFailures: number };
  stats: {
    total: number;
    enabled: number;
    disabled: number;
    running: number;
    backoffActive: number;
    withIssues: number;
    chats: number;
  };
  groups: ScheduleGroup[];
}
