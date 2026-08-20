import type {
  AgentProfile,
  BossDecision,
  BossPersona,
  BossPersonaPreset,
  ChatSummary,
  ChatMessage,
  ProviderInfo,
  ProvidersResp,
  ProviderTestResult,
  CredentialsResp,
  ScheduleEntry,
  SchedulesResp,
  SettingsResp,
  QoderModelOption,
  Task,
  TeamGraph,
  ToolCatalog,
  Squad,
  CacheStats,
  McpScope,
  McpServerDecl,
  McpServersResp,
  SkillsResp,
  ExternalSkillsResp,
  TeamImportPlan,
  TeamExportPreview,
  TeamImportView,
} from "./types";

async function j<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  /** 活跃编队（SOP 流转）列表 */
  squads: () => j<{ squads: Squad[] }>("/api/console/squads"),
  squad: (taskId: string) =>
    j<{ squad: Squad }>(`/api/console/squads/${encodeURIComponent(taskId)}`),
  team: () => j<TeamGraph>("/api/console/team"),
  toolCatalog: () => j<ToolCatalog>("/api/console/tool-catalog"),
  /** Prompt cache 用量（按 agent 聚合）；缓存失效是静默的，只能靠这个发现 */
  cacheStats: (days = 7) => j<CacheStats>(`/api/console/cache-stats?days=${days}`),
  agentDetail: (id: string) =>
    j<{
      id: string;
      configurable: boolean;
      config: AgentProfile | null;
      [k: string]: unknown;
    }>(`/api/console/agents/${encodeURIComponent(id)}`),
  createAgent: (cfg: AgentProfile) =>
    j<{ ok: true; id: string }>("/api/console/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  updateAgent: (cfg: AgentProfile) =>
    j<{ ok: true; id: string }>(`/api/console/agents/${encodeURIComponent(cfg.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  deleteAgent: (id: string) =>
    j<{ ok: true; id: string }>(`/api/console/agents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  chats: (state: "all" | "active" = "all") =>
    j<{ chats: ChatSummary[] }>(`/api/console/chats?state=${state}`),
  chatTasks: (chatId: string) =>
    j<{ chatId: string; tasks: Task[] }>(
      `/api/console/chats/${encodeURIComponent(chatId)}/tasks`,
    ),
  /** 会话维度的主管决策流（分诊/直答没有 taskId，只能在这里看） */
  chatBossLog: (chatId: string) =>
    j<{ chatId: string; decisions: BossDecision[] }>(
      `/api/console/chats/${encodeURIComponent(chatId)}/boss-log`,
    ),
  /** 会话历史消息（切换会话时加载） */
  chatMessages: (chatId: string, limit = 200) =>
    j<{ chatId: string; messages: ChatMessage[] }>(
      `/api/console/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`,
    ),
  /** 给会话起个人类可读的名字（钉钉不提供群名） */
  setChatTitle: (chatId: string, title: string) =>
    j<{ ok: true }>(`/api/console/chats/${encodeURIComponent(chatId)}/title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  taskDetail: (id: string) => j<{ task: Task }>(`/api/console/tasks/${encodeURIComponent(id)}`),
  taskStreamUrl: (id: string) => `/api/console/tasks/${encodeURIComponent(id)}/stream`,

  // ─── 定时任务（全局视图：跨所有会话，不按会话过滤） ────
  schedules: () => j<SchedulesResp>("/api/console/schedules"),
  setScheduleEnabled: (id: string, enabled: boolean) =>
    j<{ ok: true; schedule: ScheduleEntry; warnings: string[] }>(
      `/api/console/schedules/${encodeURIComponent(id)}/enabled`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      },
    ),
  deleteSchedule: (id: string, force = false) =>
    j<{ ok: true; id: string; title: string }>(
      `/api/console/schedules/${encodeURIComponent(id)}${force ? "?force=1" : ""}`,
      { method: "DELETE" },
    ),

  // ─── 设置 ─────────────────────────────────────────────
  settings: () => j<SettingsResp>("/api/console/settings"),
  saveSettings: (patch: Record<string, unknown>) =>
    j<{ ok: true; overlayKeys: string[] }>("/api/console/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  providers: () => j<ProvidersResp>("/api/console/providers"),
  /** Qoder 可用模型档位（模型下拉数据源）；refresh=true 绕过服务端 5 分钟缓存 */
  qoderModels: (refresh = false) =>
    j<{ runtimeKind: string; models: QoderModelOption[] }>(
      `/api/console/qoder/models${refresh ? "?refresh=1" : ""}`,
    ),
  /** 写 Qoder 授权密钥（只写不读）；key 传空串 = 清除 */
  setQoderSecret: (kind: "accessToken" | "serviceAccount", key: string) =>
    j<{ ok: true; kind: string; hasSecret: boolean }>("/api/console/qoder/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, key }),
    }),
  createProvider: (p: ProviderInfo & { key?: string }) =>
    j<{ ok: true; id: string }>("/api/console/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }),
  updateProvider: (p: ProviderInfo) =>
    j<{ ok: true; id: string }>(`/api/console/providers/${encodeURIComponent(p.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }),
  deleteProvider: (id: string, force = false) =>
    j<{ ok: true; id: string }>(
      `/api/console/providers/${encodeURIComponent(id)}${force ? "?force=1" : ""}`,
      { method: "DELETE" },
    ),
  setProviderSecret: (id: string, key: string) =>
    j<{ ok: true; id: string; hasSecret: boolean }>(
      `/api/console/providers/${encodeURIComponent(id)}/secret`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      },
    ),
  testProvider: (id: string, model?: string) =>
    j<ProviderTestResult>(`/api/console/providers/${encodeURIComponent(id)}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(model ? { model } : {}),
    }),

  // ─── 命名凭据（渠道 / 搜索工具，只写不回显） ───────────
  credentials: () => j<CredentialsResp>("/api/console/credentials"),
  setCredential: (key: string, value: string) =>
    j<{ ok: true; slot: string; hasValue: boolean }>(
      `/api/console/credentials/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      },
    ),
  restartChannel: (name: string) =>
    j<{ ok: boolean; channel?: string; error?: string }>(
      `/api/console/channels/${encodeURIComponent(name)}/restart`,
      { method: "POST" },
    ),

  // ─── 工具管理：MCP servers ───────────────────────────
  mcpServers: () => j<McpServersResp>("/api/console/mcp-servers"),
  createMcpServer: (s: { name: string; scope: McpScope; decl: McpServerDecl }) =>
    j<{ ok: true; name: string }>("/api/console/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }),
  updateMcpServer: (s: { name: string; scope: McpScope; decl: McpServerDecl }) =>
    j<{ ok: true; name: string }>(`/api/console/mcp-servers/${encodeURIComponent(s.name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }),
  deleteMcpServer: (name: string, force = false) =>
    j<{ ok: true; name: string }>(
      `/api/console/mcp-servers/${encodeURIComponent(name)}${force ? "?force=1" : ""}`,
      { method: "DELETE" },
    ),

  // ─── 工具管理：Skills ───────────────────────────────
  skills: () => j<SkillsResp>("/api/console/skills"),
  /** 取 SKILL.md 原文（含 frontmatter）供编辑器回填 */
  skillBody: (ref: string) =>
    j<{ ref: string; raw: string }>(`/api/console/skills/${encodeURIComponent(ref)}/body`),
  createSkill: (s: { name: string; description: string; body: string }) =>
    j<{ ok: true; name: string; ref: string }>("/api/console/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }),
  updateSkill: (s: { name: string; description: string; body: string }) =>
    j<{ ok: true; name: string }>(`/api/console/skills/${encodeURIComponent(s.name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }),
  /** 外部目录里的可导入候选（~/.claude、~/.qoder 等；这些目录不参与运行时扫描） */
  externalSkills: () => j<ExternalSkillsResp>("/api/console/skills/external"),
  importSkill: (name: string) =>
    j<{ ok: true; name: string; ref: string; extras: string[] }>("/api/console/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  deleteSkill: (name: string, force = false) =>
    j<{ ok: true; name: string }>(
      `/api/console/skills/${encodeURIComponent(name)}${force ? "?force=1" : ""}`,
      { method: "DELETE" },
    ),

  boss: () =>
    j<{
      persona: BossPersona;
      overlayKeys: string[];
      presets: BossPersonaPreset[];
      activePresetId?: string;
    }>("/api/console/boss"),
  setBossPersona: (id: string) =>
    j<{ ok: true; message: string; persona: BossPersona; activePresetId?: string }>(
      "/api/console/boss/persona",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      },
    ),
  saveBoss: (patch: Partial<BossPersona>) =>
    j<{ ok: true; persona: BossPersona }>("/api/console/boss", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),

  // ─── 团队配置分享 ─────────────────────────────────────
  previewTeamExport: (options: Record<string, unknown>) =>
    j<TeamExportPreview>("/api/console/team-bundles/export/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    }),
  createTeamExport: (options: Record<string, unknown>) =>
    j<{ id: string; filename: string; downloadUrl: string; summary: any }>(
      "/api/console/team-bundles/export",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      },
    ),
  uploadTeamImport: async (file: File): Promise<TeamImportView> => {
    const res = await fetch(
      `/api/console/team-bundles/imports?filename=${encodeURIComponent(file.name)}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
    );
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json() as Promise<TeamImportView>;
  },
  teamImport: (id: string) =>
    j<TeamImportView>(`/api/console/team-bundles/imports/${encodeURIComponent(id)}`),
  updateTeamImportPlan: (id: string, plan: TeamImportPlan) =>
    j<{ record: TeamImportView["record"] }>(
      `/api/console/team-bundles/imports/${encodeURIComponent(id)}/plan`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan) },
    ),
  confirmTeamImport: (id: string, acknowledgeReplace = false) =>
    j<{ token: string; expiresAt: string; elevated: boolean }>(
      `/api/console/team-bundles/imports/${encodeURIComponent(id)}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledgeReplace }),
      },
    ),
  applyTeamImport: (id: string, token: string) =>
    j<any>(`/api/console/team-bundles/imports/${encodeURIComponent(id)}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  teamBundleHistory: () =>
    j<{ imports: any[]; snapshots: any[] }>("/api/console/team-bundles/history"),
  rollbackTeamSnapshot: (snapshotId: string) =>
    j<{ safetySnapshotId: string }>(
      `/api/console/team-bundles/rollback/${encodeURIComponent(snapshotId)}`,
      { method: "POST" },
    ),
};

/** SSE 事件订阅，返回 close 函数 */
export function subscribeTaskStream(
  taskId: string,
  handlers: {
    onTrace?: (ev: unknown) => void;
    onAgentEvent?: (ev: unknown) => void;
    onStateChange?: (ev: unknown) => void;
    onBossDecision?: (ev: BossDecision) => void;
    onError?: (err: Event) => void;
    onReplayEnd?: () => void;
  },
): () => void {
  const es = new EventSource(api.taskStreamUrl(taskId));
  const parse = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  es.addEventListener("trace", (e) => handlers.onTrace?.(parse((e as MessageEvent).data)));
  es.addEventListener("agent_event", (e) =>
    handlers.onAgentEvent?.(parse((e as MessageEvent).data)),
  );
  es.addEventListener("state_change", (e) =>
    handlers.onStateChange?.(parse((e as MessageEvent).data)),
  );
  es.addEventListener("boss_decision", (e) =>
    handlers.onBossDecision?.(parse((e as MessageEvent).data) as BossDecision),
  );
  es.addEventListener("replay_end", () => handlers.onReplayEnd?.());
  es.onerror = (e) => handlers.onError?.(e);
  return () => es.close();
}

/**
 * 向某个会话发一条消息（不等回复）。
 *
 * boss 的回复**不在**本请求的响应里——`/api/boss/run` 不传 `wait` 时立即返回 JSON，
 * 出站消息统一走 `/api/boss/events` 常驻流（与钉钉 webhook 同构）。所以发送与接收是
 * 两条独立通道，必须配 subscribeBossEvents 使用。
 */
export async function postBossMessage(input: {
  prompt: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
}): Promise<{ ok: true; chatId: string }> {
  return j<{ ok: true; chatId: string }>("/api/boss/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * 常驻订阅某个会话的 boss 出站消息。返回 close 函数。
 *
 * 用常驻流而不是等某次请求的 SSE：这样后台任务几小时后的验收汇报、以及**钉钉那边
 * 其他人**触发的对话，都会实时出现在后台页面上。
 */
export function subscribeBossEvents(
  chatId: string,
  onMessage: (text: string) => void,
  onError?: (e: unknown) => void,
): () => void {
  const es = new EventSource(`/api/boss/events?chatId=${encodeURIComponent(chatId)}`);
  es.addEventListener("boss_message", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as { text?: string };
      if (data?.text) onMessage(data.text);
    } catch {
      /* 忽略坏帧 */
    }
  });
  es.onerror = (e) => onError?.(e);
  return () => es.close();
}
