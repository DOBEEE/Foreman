import type { Router, Request, Response } from "express";
import { config } from "../config/index.js";
import { testProvider } from "../core/onboarding.js";
import {
  getSettingsOverlay,
  patchSettings,
  readBossOverlay,
  writeBossOverlay,
} from "../config/settings-store.js";
import {
  deleteProvider,
  getProvider,
  hasSecret,
  listProviders,
  maskSecret,
  getProviderSecret,
  saveProvider,
  setProviderSecret,
  validateProvider,
  type ProviderInfo,
} from "../config/providers-store.js";
import {
  CREDENTIAL_SLOTS,
  isCredentialSlot,
  listCredentialStatus,
  setCredential,
} from "../config/credentials-store.js";
import { restartChannel } from "../channels/registry.js";
import {
  applyBossPersona,
  currentBossPersonaId,
  listBossPersonas,
  loadBossPersona,
} from "../boss/persona.js";
import { listAgents } from "../agents/registry.js";
import { loadAgentProfile } from "../config/agent-profile.js";
import { join } from "node:path";
import { builtinMcpFile, listMcpServers } from "../core/mcp.js";
import {
  deleteMcpServer,
  saveMcpServer,
  userMcpExists,
  validateMcpServer,
  type McpServerInput,
} from "../config/mcp-store.js";
import {
  deleteSkill,
  importExternalSkill,
  listExternalSkills,
  listSkills,
  readSkillBody,
  saveSkill,
  userSkillExists,
} from "../core/skill-store.js";

/** 改这些字段需重启进程才生效（绑定在启动期）——UI 据此打「需重启」徽章 */
const RESTART_REQUIRED = ["port", "dashboardAccess", "paths.runtimeDir"];

/** dashboard 可编辑的设置字段（白名单）：其余 AppFile 字段不开放，避免误伤 */
const EDITABLE_TOP = new Set([
  "publicBaseUrl",
  "model",
  "routerModel",
  "defaultProviderId",
  "boss",
  "qoder",
  "maxTurns",
  "maxAutoContinues",
  "maxConcurrentRuns",
  "memory",
  "disabledTools",
  "assist",
  "compact",
  "dingtalk",
  "retro",
  "optimizer",
  "paths",
  "taskWorkspace",
]);

function pickEditable(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (EDITABLE_TOP.has(k)) out[k] = v;
  return out;
}

/** 供应商回显：附 hasSecret + 掩码，绝不吐明文 */
function publicProvider(p: ProviderInfo) {
  return {
    ...p,
    hasSecret: hasSecret(p.id),
    secretMask: maskSecret(getProviderSecret(p.id)),
  };
}

/** 谁在引用这个供应商（删除前告警：全局默认 / 主管 / 各员工） */
function providerRefs(id: string): string[] {
  const refs: string[] = [];
  if (config.defaultProviderId === id) refs.push("全局默认");
  if (config.boss.providerId === id) refs.push("主管");
  for (const a of listAgents()) {
    const prof = loadAgentProfile(a.name);
    if (prof?.provider?.id === id) refs.push(prof.displayName ?? a.name);
  }
  return refs;
}

import { QODER_SECRET_KEY } from "../runtime/qoder-runtime.js";

export function registerSettingsRoutes(router: Router): void {
  // ─── 通用设置 ────────────────────────────────────────
  router.get("/settings", (_req: Request, res: Response) => {
    const overlay = getSettingsOverlay();
    res.json({
      effective: {
        publicBaseUrl: config.publicBaseUrl,
        model: config.model ?? "",
        routerModel: config.routerModel ?? "",
        defaultProviderId: config.defaultProviderId ?? "",
        boss: { providerId: config.boss.providerId ?? "", model: config.boss.model ?? "" },
        /** 前端据此决定模型字段是「自由文本」还是「Qoder 档位下拉」 */
        runtimeKind: config.runtimeKind,
        qoder: {
          model: config.qoder.model ?? "",
          auth: {
            mode: config.qoder.auth.mode,
            envVar: config.qoder.auth.envVar ?? "",
            /** 只报「有没有」，绝不回显密钥明文 */
            hasAccessToken: hasSecret(QODER_SECRET_KEY.accessToken),
            hasServiceAccount: hasSecret(QODER_SECRET_KEY.serviceAccount),
          },
        },
        maxTurns: config.maxTurns,
        maxAutoContinues: config.maxAutoContinues,
        maxConcurrentRuns: config.maxConcurrentRuns,
        taskWorkspace: { retentionDays: config.taskWorkspace.retentionDays },
        memory: config.memoryEnabled,
        disabledTools: config.disabledTools,
        dashboardAccess: config.dashboardAccess,
        port: config.port,
        assist: config.assist,
        compact: config.compact,
        dingtalk: config.dingtalk,
        retro: config.retro,
        optimizer: config.optimizer,
        paths: {
          workingDir: config.workingDir,
          knowledgeDir: config.knowledgeDir,
          pluginsDir: config.pluginsDir,
          codeRoots: config.codeRoots,
          runtimeDir: config.runtimeDir,
        },
      },
      overlayKeys: Object.keys(overlay),
      restartRequired: RESTART_REQUIRED,
      // .env 兜底凭据存在性（不回显值）：帮用户判断「不配供应商也能跑吗」
      envCreds: {
        hasAuthToken: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
        hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
        baseUrl: process.env.ANTHROPIC_BASE_URL ?? "",
      },
    });
  });

  router.put("/settings", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch = pickEditable(body);
    if (Object.keys(patch).length === 0)
      return res.status(400).json({ error: "没有可写入的设置字段" });
    try {
      const overlay = patchSettings(patch);
      res.json({ ok: true, overlayKeys: Object.keys(overlay) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ─── Qoder 可用模型（仅 qoder runtime 有意义）────────
  // 前端模型下拉的数据源。列表由 runtime 层带 5 分钟缓存（起一次 qodercli 会话约 6s），
  // `?refresh=1` 强制向服务端要最新。
  router.get("/qoder/models", async (req: Request, res: Response) => {
    const { listQoderModels, toModelOptions } = await import("../runtime/qoder-models.js");
    const models = await listQoderModels({ refresh: req.query.refresh === "1" });
    res.json({ runtimeKind: config.runtimeKind, models: toModelOptions(models) });
  });

  /**
   * 写 Qoder 授权密钥（PAT / 服务账号）。走与供应商密钥同一套存储
   * （secrets.json，0o600），**只写不读**：GET 只报 hasXxx，绝不回显明文。
   * 传空字符串 = 清除该密钥。
   */
  router.put("/qoder/secret", (req: Request, res: Response) => {
    const { kind, key } = (req.body ?? {}) as { kind?: string; key?: string };
    if (kind !== "accessToken" && kind !== "serviceAccount") {
      return res.status(400).json({ error: 'kind 需为 "accessToken" 或 "serviceAccount"' });
    }
    const secretId = QODER_SECRET_KEY[kind];
    setProviderSecret(secretId, (key ?? "").trim());
    res.json({ ok: true, kind, hasSecret: hasSecret(secretId) });
  });

  // ─── 模型供应商 ──────────────────────────────────────
  router.get("/providers", (_req: Request, res: Response) => {
    res.json({
      defaultProviderId: config.defaultProviderId ?? "",
      providers: listProviders().map(publicProvider),
    });
  });

  router.post("/providers", (req: Request, res: Response) => {
    const p = req.body as ProviderInfo & { key?: string };
    const errs = validateProvider(p);
    if (errs.length) return res.status(400).json({ error: errs.join("; ") });
    if (getProvider(p.id))
      return res.status(409).json({ error: `供应商 ${p.id} 已存在，用 PUT 修改` });
    try {
      saveProvider({ ...p, createdBy: "dashboard" });
      if (p.key) setProviderSecret(p.id, p.key); // 允许创建时一并带上密钥
      res.json({ ok: true, id: p.id });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.put("/providers/:id", (req: Request, res: Response) => {
    const id = req.params.id;
    const p = req.body as ProviderInfo;
    if (id !== p?.id) return res.status(400).json({ error: "URL id 与 body.id 不一致" });
    if (!getProvider(id)) return res.status(404).json({ error: "供应商不存在" });
    try {
      saveProvider(p);
      res.json({ ok: true, id });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.delete("/providers/:id", (req: Request, res: Response) => {
    const id = req.params.id;
    if (!getProvider(id)) return res.status(404).json({ error: "供应商不存在" });
    const refs = providerRefs(id);
    if (refs.length > 0 && req.query.force !== "1") {
      return res.status(409).json({
        error: `该供应商仍被引用：${refs.join("、")}。改用其它供应商后再删，或加 ?force=1 强删`,
        refs,
      });
    }
    try {
      deleteProvider(id);
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 密钥：只写不读回。GET 一律走 /providers 的掩码
  router.put("/providers/:id/secret", (req: Request, res: Response) => {
    const id = req.params.id;
    if (!getProvider(id)) return res.status(404).json({ error: "供应商不存在" });
    const key = (req.body as { key?: unknown })?.key;
    if (typeof key !== "string")
      return res.status(400).json({ error: "key 必须是字符串（传空串清除）" });
    try {
      setProviderSecret(id, key.trim());
      res.json({ ok: true, id, hasSecret: hasSecret(id) });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ─── 命名凭据（渠道 / 搜索工具，落 credentials.json 0600，只写不回显） ───
  router.get("/credentials", (_req: Request, res: Response) => {
    res.json({ credentials: listCredentialStatus(), slots: Object.keys(CREDENTIAL_SLOTS) });
  });

  router.put("/credentials/:key", (req: Request, res: Response) => {
    const key = req.params.key;
    if (!isCredentialSlot(key)) return res.status(400).json({ error: `未知凭据槽位：${key}` });
    const value = (req.body as { value?: unknown })?.value;
    if (typeof value !== "string")
      return res.status(400).json({ error: "value 必须是字符串（传空串清除）" });
    try {
      setCredential(key, value.trim());
      const status = listCredentialStatus().find((c) => c.slot === key);
      res.json({ ok: true, slot: key, hasValue: status?.hasValue ?? false });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 重启单个渠道：让 web 里改的钉钉凭据在收消息的长连接上生效（stop → start 重连）
  router.post("/channels/:type/restart", (req: Request, res: Response) => {
    void (async () => {
      try {
        await restartChannel(req.params.type);
        res.json({ ok: true, channel: req.params.type });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });

  // 连通性测试：用该供应商的 env + 模型跑一次最小调用
  // 判定逻辑在 core/onboarding.ts::testProvider —— CLI 首启向导用的是同一份，两处不能各写一遍
  router.post("/providers/:id/test", (req: Request, res: Response) => {
    void (async () => {
      const id = req.params.id;
      if (!getProvider(id)) return res.status(404).json({ error: "供应商不存在" });
      if (!hasSecret(id))
        return res.status(400).json({ error: "尚未配置密钥，先保存 key 再测试" });
      res.json(await testProvider(id, (req.body as { model?: string })?.model));
    })();
  });

  // ─── MCP servers ─────────────────────────────────────
  /** 谁点名了这个 optional MCP（删除前告警） */
  function mcpRefs(name: string): string[] {
    const refs: string[] = [];
    for (const a of listAgents()) {
      const prof = loadAgentProfile(a.name);
      if (prof?.mcpServers?.includes(name)) refs.push(prof.displayName ?? a.name);
      // tools 白名单里的 mcp__<name> 也算引用（那是 MCP 授权范围的写法）
      else if (prof?.tools?.some((t) => t === `mcp__${name}` || t.startsWith(`mcp__${name}__`)))
        refs.push(prof.displayName ?? a.name);
    }
    return [...new Set(refs)];
  }

  router.get("/mcp-servers", (_req: Request, res: Response) => {
    res.json({
      builtinFile: builtinMcpFile(),
      userFile: config.userMcpFile,
      servers: listMcpServers().map((s) => ({ ...s, refs: mcpRefs(s.name) })),
    });
  });

  router.post("/mcp-servers", (req: Request, res: Response) => {
    const input = req.body as McpServerInput;
    const errs = validateMcpServer(input);
    if (errs.length) return res.status(400).json({ error: errs.join("; ") });
    const existing = listMcpServers().find((s) => s.name === input.name);
    if (existing) {
      return res.status(409).json({ error: `MCP "${input.name}" 已存在，用 PUT 修改` });
    }
    try {
      saveMcpServer(input);
      res.json({ ok: true, name: input.name });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.put("/mcp-servers/:name", (req: Request, res: Response) => {
    const name = req.params.name;
    const input = req.body as McpServerInput;
    if (name !== input?.name)
      return res.status(400).json({ error: "URL name 与 body.name 不一致" });
    const existing = listMcpServers().find((s) => s.name === name);
    if (!existing) return res.status(404).json({ error: "MCP 不存在" });
    if (existing.source === "builtin" && !userMcpExists(name)) {
      return res.status(400).json({
        error: `内置 MCP 不可通过 dashboard 修改（改 ${builtinMcpFile()}）`,
      });
    }
    try {
      saveMcpServer(input);
      res.json({ ok: true, name });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.delete("/mcp-servers/:name", (req: Request, res: Response) => {
    const name = req.params.name;
    const existing = listMcpServers().find((s) => s.name === name);
    if (!existing) return res.status(404).json({ error: "MCP 不存在" });
    if (existing.source === "builtin") {
      return res.status(400).json({ error: "内置 MCP 不可删除（改内置声明文件）" });
    }
    const refs = mcpRefs(name);
    if (refs.length > 0 && req.query.force !== "1") {
      return res.status(409).json({
        error: `该 MCP 仍被引用：${refs.join("、")}。先改这些岗位的配置，或加 ?force=1 强删`,
        refs,
      });
    }
    try {
      deleteMcpServer(name);
      res.json({ ok: true, name });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ─── Skills ──────────────────────────────────────────
  /**
   * 谁在 profile.skills 里声明了这个 skill。
   * 兼容短名写法：loadSkills 允许省略 builtin:/user: 前缀，引用检查也得跟着兼容，
   * 否则「声明写了短名」的岗位在删除时不会被拦下来。
   */
  function skillRefs(ref: string): string[] {
    const short = ref.split(":").pop();
    const refs: string[] = [];
    for (const a of listAgents()) {
      const declared = loadAgentProfile(a.name)?.skills ?? [];
      if (declared.some((d) => d === ref || d === short)) {
        refs.push(loadAgentProfile(a.name)?.displayName ?? a.name);
      }
    }
    return [...new Set(refs)];
  }

  router.get("/skills", (_req: Request, res: Response) => {
    res.json({
      builtinDir: join(config.pluginsDir, "skills"),
      userDir: join(config.userPluginsDir, "skills"),
      skills: listSkills().map((s) => ({ ...s, declaredBy: skillRefs(s.ref) })),
    });
  });

  /** 取 SKILL.md 原文（含 frontmatter）供编辑器回填 */
  router.get("/skills/:ref/body", (req: Request, res: Response) => {
    const raw = readSkillBody(req.params.ref);
    if (raw == null) return res.status(404).json({ error: "skill 不存在" });
    res.json({ ref: req.params.ref, raw });
  });

  router.post("/skills", (req: Request, res: Response) => {
    const s = req.body as { name?: string; description?: string; body?: string };
    if (typeof s?.name !== "string" || typeof s?.description !== "string" || typeof s?.body !== "string") {
      return res.status(400).json({ error: "name / description / body 都必填" });
    }
    if (userSkillExists(s.name)) {
      return res.status(409).json({ error: `skill "${s.name}" 已存在，用 PUT 修改` });
    }
    if (listSkills().some((x) => x.source === "builtin" && x.name === s.name)) {
      return res.status(409).json({
        error: `与内置 skill "${s.name}" 同名。用户侧同名会遮蔽内置的，换个名字`,
      });
    }
    try {
      saveSkill({ name: s.name, description: s.description, body: s.body });
      res.json({ ok: true, name: s.name, ref: `user:${s.name}` });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.put("/skills/:name", (req: Request, res: Response) => {
    const name = req.params.name;
    const s = req.body as { name?: string; description?: string; body?: string };
    if (name !== s?.name) return res.status(400).json({ error: "URL name 与 body.name 不一致" });
    if (typeof s.description !== "string" || typeof s.body !== "string") {
      return res.status(400).json({ error: "description / body 都必填" });
    }
    if (!userSkillExists(name)) {
      // 内置 skill 走到这里就是想改内置——给出与 agent 一致的口径
      const builtin = listSkills().find((x) => x.source === "builtin" && x.name === name);
      if (builtin) {
        return res.status(400).json({
          error: `内置 skill 不可通过 dashboard 修改（改 ${join(config.pluginsDir, "skills", name, "SKILL.md")}）`,
        });
      }
      return res.status(404).json({ error: "skill 不存在" });
    }
    try {
      saveSkill({ name, description: s.description, body: s.body });
      res.json({ ok: true, name });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.delete("/skills/:name", (req: Request, res: Response) => {
    const name = req.params.name;
    if (!userSkillExists(name)) {
      const builtin = listSkills().find((x) => x.source === "builtin" && x.name === name);
      if (builtin) return res.status(400).json({ error: "内置 skill 不可删除（删仓库里的文件）" });
      return res.status(404).json({ error: "skill 不存在" });
    }
    const refs = skillRefs(`user:${name}`);
    if (refs.length > 0 && req.query.force !== "1") {
      return res.status(409).json({
        error: `该 skill 仍被声明引用：${refs.join("、")}。先改这些岗位的 skills，或加 ?force=1 强删`,
        refs,
      });
    }
    try {
      deleteSkill(name);
      res.json({ ok: true, name });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * 外部目录（其他 coding agent 装的 skill）里可导入的候选。
   * 这些目录不参与运行时扫描——几十个 skill 全进 L1 清单会污染每个 agent 的上下文，
   * 所以要用哪个就显式导入哪个。
   */
  router.get("/skills/external", (_req: Request, res: Response) => {
    res.json({ roots: config.externalSkillDirs, skills: listExternalSkills() });
  });

  /** 导入一个外部 skill。只接受名字（源路径由服务端从候选里取，不让调用方指定路径） */
  router.post("/skills/import", (req: Request, res: Response) => {
    const name = (req.body as { name?: unknown })?.name;
    if (typeof name !== "string" || !name) {
      return res.status(400).json({ error: "name 必填" });
    }
    try {
      const r = importExternalSkill(name);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ─── 主管基础信息 ────────────────────────────────────
  router.get("/boss", (_req: Request, res: Response) => {
    const persona = loadBossPersona();
    res.json({
      persona,
      overlayKeys: Object.keys(readBossOverlay()),
      presets: listBossPersonas(),
      activePresetId: currentBossPersonaId(),
    });
  });

  /** 切换人格预设。整对象覆写（见 applyBossPersona），换完旧会话自动作废 */
  router.post("/boss/persona", (req: Request, res: Response) => {
    const id = (req.body ?? {}).id;
    if (typeof id !== "string" || !id.trim())
      return res.status(400).json({ error: "缺少人格预设 id" });
    const out = applyBossPersona(id);
    if (!out.ok) return res.status(400).json({ error: out.message });
    res.json({ ok: true, message: out.message, persona: loadBossPersona(), activePresetId: currentBossPersonaId() });
  });

  router.put("/boss", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ALLOWED = ["name", "role", "personality", "style", "team", "avatar", "employees"];
    const next: Record<string, unknown> = { ...readBossOverlay() };
    for (const k of ALLOWED) if (k in body) next[k] = body[k];
    if (typeof next.name === "string" && !(next.name as string).trim())
      return res.status(400).json({ error: "主管名字不能为空" });
    try {
      writeBossOverlay(next);
      res.json({ ok: true, persona: loadBossPersona() });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
