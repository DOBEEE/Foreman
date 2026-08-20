import { useEffect, useState } from "react";
import { api } from "../api";
import { QoderModelPicker } from "../components/QoderModelPicker";
import type {
  BossPersona,
  BossPersonaPreset,
  McpScope,
  McpServerDecl,
  McpServerEntry,
  McpServersResp,
  ProviderInfo,
  ProvidersResp,
  ProviderTestResult,
  CredentialStatus,
  SettingsEffective,
  SettingsResp,
  SkillEntry,
  SkillsResp,
  ExternalSkillsResp,
  TeamImportMode,
  TeamImportPlan,
  TeamExportPreview,
  TeamImportView,
} from "../types";

type Tab = "general" | "models" | "channels" | "mcp" | "skills" | "boss" | "team";

const TABS: Tab[] = ["general", "models", "channels", "mcp", "skills", "boss", "team"];

/** 从 URL 读初始页签：组织架构页的「分享/导入团队」入口靠它直接落到团队配置页 */
function initialTab(): Tab {
  const raw = new URLSearchParams(window.location.search).get("tab");
  return TABS.includes(raw as Tab) ? (raw as Tab) : "general";
}

export function SettingsPage() {
  const [tab, setTabState] = useState<Tab>(initialTab);
  /**
   * 切页签时同步回 URL，这样「复制链接发给别人」和「刷新页面」都还在同一页。
   * 用 replaceState 而不是 pushState：页签不是导航层级，塞进历史栈会让返回键
   * 在页签之间来回跳而不是真的返回上一页。
   */
  const setTab = (next: Tab): void => {
    setTabState(next);
    const url = new URL(window.location.href);
    if (next === "general") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url.toString());
  };
  return (
    <div className="settings">
      <div className="settings-tabs">
        <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>
          通用
        </button>
        <button className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>
          模型与凭据
        </button>
        <button className={tab === "channels" ? "active" : ""} onClick={() => setTab("channels")}>
          渠道与密钥
        </button>
        <button className={tab === "mcp" ? "active" : ""} onClick={() => setTab("mcp")}>
          MCP
        </button>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>
          技能
        </button>
        <button className={tab === "boss" ? "active" : ""} onClick={() => setTab("boss")}>
          主管
        </button>
        <button className={tab === "team" ? "active" : ""} onClick={() => setTab("team")}>
          团队配置
        </button>
      </div>
      <div className="settings-body">
        {tab === "general" && <GeneralTab />}
        {tab === "models" && <ModelsTab />}
        {tab === "channels" && <ChannelsTab />}
        {tab === "mcp" && <McpTab />}
        {tab === "skills" && <SkillsTab />}
        {tab === "boss" && <BossTab />}
        {tab === "team" && <TeamConfigTab onGoMcp={() => setTab("mcp")} />}
      </div>
    </div>
  );
}

function Saved({ at }: { at: number }) {
  if (!at) return null;
  return <span style={{ color: "var(--success)", marginLeft: 10 }}>✓ 已保存</span>;
}

// ─── 通用 ────────────────────────────────────────────────
function GeneralTab() {
  const [data, setData] = useState<SettingsResp | null>(null);
  const [form, setForm] = useState<Partial<SettingsEffective>>({});
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [err, setErr] = useState<string>();
  const [savedAt, setSavedAt] = useState(0);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [s, p] = await Promise.all([api.settings(), api.providers()]);
    setData(s);
    setForm(structuredClone(s.effective));
    setProviders(p.providers);
  };
  useEffect(() => {
    void load().catch((e) => setErr(String(e)));
  }, []);

  if (!data) return <div className="hint">加载中…</div>;
  const e = data.effective;
  const f = form;
  const set = (p: Partial<SettingsEffective>) => setForm((c) => ({ ...c, ...p }));
  // qoder 配置的规范化视图：表单未动过该字段时回落 effective，避免到处判 undefined
  const q: SettingsEffective["qoder"] = f.qoder ?? e.qoder;
  // qoder 与 vercel 的模型体系互斥：两套字段同时显示会误导（曾同时列出 model 与 qoder.model）
  const isQoder = e.runtimeKind === "qoder";
  // 压缩配置的规范化视图：表单未动过时回落 effective
  const cp: SettingsEffective["compact"] = f.compact ?? e.compact;

  const save = async () => {
    setSaving(true);
    setErr(undefined);
    try {
      // 只提交改动过的字段（与加载时的 effective 比对），避免把 env/默认值固化进覆盖层
      const patch: Record<string, unknown> = {};
      const keys: (keyof SettingsEffective)[] = [
        "publicBaseUrl",
        "model",
        "qoder",
        "routerModel",
        "defaultProviderId",
        "maxTurns",
        "maxAutoContinues",
        "maxConcurrentRuns",
        "memory",
        "disabledTools",
        "assist",
        "compact",
        "retro",
      ];
      for (const k of keys) {
        if (JSON.stringify(f[k]) !== JSON.stringify(e[k])) patch[k] = f[k];
      }
      if (Object.keys(patch).length === 0) {
        setSavedAt(Date.now());
        return;
      }
      await api.saveSettings(patch);
      await load();
      setSavedAt(Date.now());
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setSaving(false);
    }
  };

  const overlaid = (k: string) => data.overlayKeys.includes(k);

  return (
    <div className="settings-form">
      {err && <div style={{ color: "var(--danger)" }}>⚠️ {err}</div>}

      <h3>基础</h3>
      <label>
        对外服务地址 publicBaseUrl {overlaid("publicBaseUrl") && <Badge>已覆盖</Badge>}
        <span className="hint">渠道消息里任务详情链接的前缀</span>
      </label>
      <input value={f.publicBaseUrl ?? ""} onChange={(x) => set({ publicBaseUrl: x.target.value })} />

      {/* 模型体系按 runtime 二选一：vercel 用 Anthropic/OpenAI 模型名，qoder 用自己的档位 */}
      {!isQoder && (
        <>
          <label>
            全局默认模型 model {overlaid("model") && <Badge>已覆盖</Badge>}
            <span className="hint">留空用供应商默认 / SDK 默认</span>
          </label>
          <input value={f.model ?? ""} onChange={(x) => set({ model: x.target.value })} />
        </>
      )}

      {isQoder && (
        <>
          <label>
            全局默认模型档位 qoder.model {overlaid("qoder") && <Badge>已覆盖</Badge>}
            <span className="hint">留空 = 用 Qoder 服务端默认（auto）</span>
          </label>
          <QoderModelPicker
            value={q.model ?? ""}
            onChange={(v) => set({ qoder: { ...q, model: v } })}
          />

          <label>
            Qoder 授权方式 {overlaid("qoder") && <Badge>已覆盖</Badge>}
            <span className="hint">默认同步本机 qodercli 登录态，无需任何密钥</span>
          </label>
          <select
            value={q.auth.mode}
            onChange={(x) =>
              set({
                qoder: {
                  ...q,
                  auth: {
                    ...q.auth,
                    mode: x.target.value as SettingsEffective["qoder"]["auth"]["mode"],
                  },
                },
              })
            }
          >
            <option value="qodercli">同步本机 qodercli 登录态（推荐）</option>
            <option value="accessToken">个人访问令牌（PAT）</option>
            <option value="serviceAccount">服务账号密钥</option>
          </select>

          {q.auth.mode !== "qodercli" && (
            <>
              <label>
                密钥来源环境变量名 <span className="hint">留空则用下面保存在服务端的密钥</span>
              </label>
              <input
                value={q.auth.envVar ?? ""}
                placeholder={
                  q.auth.mode === "accessToken"
                    ? "如 QODER_PERSONAL_ACCESS_TOKEN"
                    : "如 QODER_SERVICE_ACCOUNT_KEY"
                }
                onChange={(x) =>
                  set({
                    qoder: {
                      ...q,
                      auth: { ...q.auth, envVar: x.target.value },
                    },
                  })
                }
              />
              <QoderSecretField
                kind={q.auth.mode}
                saved={
                  q.auth.mode === "accessToken"
                    ? e.qoder.auth.hasAccessToken
                    : e.qoder.auth.hasServiceAccount
                }
              />
            </>
          )}
        </>
      )}

      {/* routerModel / 供应商都是 Anthropic-OpenAI 侧概念，qoder 下不生效，隐藏避免误配 */}
      {!isQoder && (
        <>
          <label>
            路由/裁决模型 routerModel <span className="hint">主管轻量判断用；留空同 model</span>
          </label>
          <input
            value={f.routerModel ?? ""}
            onChange={(x) => set({ routerModel: x.target.value })}
          />

          <label>
            默认模型供应商 {overlaid("defaultProviderId") && <Badge>已覆盖</Badge>}
            <span className="hint">未单独配置的员工/主管走它；留空走 .env 兜底</span>
          </label>
          <select
            value={f.defaultProviderId ?? ""}
            onChange={(x) => set({ defaultProviderId: x.target.value })}
          >
            <option value="">（用 .env 兜底）</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.id}）
              </option>
            ))}
          </select>
        </>
      )}

      <h3>运行</h3>
      <div className="grid2">
        <div>
          <label>全局并发上限 maxConcurrentRuns</label>
          <input
            type="number"
            value={f.maxConcurrentRuns ?? 0}
            onChange={(x) => set({ maxConcurrentRuns: Number(x.target.value) })}
          />
        </div>
        <div>
          <label>单轮步数 maxTurns</label>
          <input
            type="number"
            value={f.maxTurns ?? 0}
            onChange={(x) => set({ maxTurns: Number(x.target.value) })}
          />
        </div>
        <div>
          <label>自动续跑次数 maxAutoContinues</label>
          <input
            type="number"
            value={f.maxAutoContinues ?? 0}
            onChange={(x) => set({ maxAutoContinues: Number(x.target.value) })}
          />
        </div>
        <div>
          <label>SDK 记忆 memory</label>
          <select
            value={f.memory ? "1" : "0"}
            onChange={(x) => set({ memory: x.target.value === "1" })}
          >
            <option value="0">关闭</option>
            <option value="1">开启</option>
          </select>
        </div>
      </div>

      <h3>上下文压缩</h3>
      <div className="hint">
        超过窗口是硬失败，所以到阈值会自动压缩历史。软阈值只在 prompt 缓存已过期时才压
        （压缩会改写上下文前缀、让缓存全量重灌，缓存还热时压反而更贵）；硬阈值无条件压。
      </div>
      <div className="grid2">
        <div>
          <label>
            上下文窗口 contextWindow <span className="hint">token；按所用模型填</span>
          </label>
          <input
            type="number"
            value={cp.contextWindow}
            onChange={(x) => set({ compact: { ...cp, contextWindow: Number(x.target.value) } })}
          />
        </div>
        <div>
          <label>
            软阈值 atPercent <span className="hint">0~1，如 0.6</span>
          </label>
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={cp.atPercent}
            onChange={(x) => set({ compact: { ...cp, atPercent: Number(x.target.value) } })}
          />
        </div>
        <div>
          <label>
            硬阈值 hardAtPercent <span className="hint">0~1，须大于软阈值</span>
          </label>
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={cp.hardAtPercent}
            onChange={(x) => set({ compact: { ...cp, hardAtPercent: Number(x.target.value) } })}
          />
        </div>
        <div>
          <label>
            主动压缩下限 minWindow <span className="hint">窗口小于它就交给 SDK 默认行为</span>
          </label>
          <input
            type="number"
            value={cp.minWindow}
            onChange={(x) => set({ compact: { ...cp, minWindow: Number(x.target.value) } })}
          />
        </div>
      </div>

      <label>
        禁用内置工具 disabledTools <span className="hint">逗号分隔，如 WebSearch,WebFetch</span>
      </label>
      <input
        value={(f.disabledTools ?? []).join(",")}
        onChange={(x) =>
          set({ disabledTools: x.target.value.split(",").map((s) => s.trim()).filter(Boolean) })
        }
      />

      <h3>主管自主协调（assist）</h3>
      <div className="grid2">
        <div>
          <label>启用</label>
          <select
            value={f.assist?.enabled ? "1" : "0"}
            onChange={(x) => set({ assist: { ...f.assist!, enabled: x.target.value === "1" } })}
          >
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
        </div>
        <div>
          <label>单任务最多代答次数</label>
          <input
            type="number"
            value={f.assist?.maxSelfAnswers ?? 0}
            onChange={(x) => set({ assist: { ...f.assist!, maxSelfAnswers: Number(x.target.value) } })}
          />
        </div>
        <div>
          <label>单任务最多改派次数</label>
          <input
            type="number"
            value={f.assist?.maxReassigns ?? 0}
            onChange={(x) => set({ assist: { ...f.assist!, maxReassigns: Number(x.target.value) } })}
          />
        </div>
      </div>

      <h3>每日复盘（retro）{overlaid("retro") && <Badge>已覆盖</Badge>}</h3>
      <div className="grid2">
        <div>
          <label>定时复盘</label>
          <select
            value={f.retro?.schedule ? "1" : "0"}
            onChange={(x) => set({ retro: { ...f.retro!, schedule: x.target.value === "1" } })}
          >
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
        </div>
        <div>
          <label>触发时刻（hour，0-23）</label>
          <input
            type="number"
            value={f.retro?.hour ?? 21}
            onChange={(x) => set({ retro: { ...f.retro!, hour: Number(x.target.value) } })}
          />
        </div>
      </div>
      <label>
        推送接收人 notifyUser <span className="hint">staffId，可逗号分隔；机器人单聊私发复盘</span>
      </label>
      <input
        value={f.retro?.notifyUser ?? ""}
        onChange={(x) => set({ retro: { ...f.retro!, notifyUser: x.target.value } })}
      />
      <label>
        推送群 notifyChat <span className="hint">群 openConversationId；机器人主动推群</span>
      </label>
      <input
        value={f.retro?.notifyChat ?? ""}
        onChange={(x) => set({ retro: { ...f.retro!, notifyChat: x.target.value } })}
      />

      <h3>评测裁判（bench）{overlaid("bench") && <Badge>已覆盖</Badge>}</h3>
      <div className="hint">
        二层 rubric 打分用的裁判模型。建议选与被测不同源的供应商（异源裁判），避免同模型自评偏袒。留空=用默认供应商 + routerModel/model。
      </div>
      <label>裁判供应商 judgeProviderId</label>
      <select
        value={f.bench?.judgeProviderId ?? ""}
        onChange={(x) => set({ bench: { ...f.bench!, judgeProviderId: x.target.value } })}
      >
        <option value="">（默认供应商）</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}（{p.id}）
          </option>
        ))}
      </select>
      <label>
        裁判模型 judgeModel <span className="hint">如 qwen-max；留空回落 routerModel/model</span>
      </label>
      <input
        value={f.bench?.judgeModel ?? ""}
        onChange={(x) => set({ bench: { ...f.bench!, judgeModel: x.target.value } })}
      />

      <div className="settings-actions">
        <button className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "保存中…" : "保存设置"}
        </button>
        <Saved at={savedAt} />
      </div>

      <h3>需重启才生效</h3>
      <div className="restart-note">
        以下项绑定在进程启动期，改动请改 .env / app.json 后重启服务：
        <ul>
          <li>端口 port = {e.port}</li>
          <li>Dashboard 访问范围 dashboardAccess = {e.dashboardAccess}</li>
          <li>运行时目录 runtimeDir = {e.paths.runtimeDir}</li>
        </ul>
        <div className="hint">
          工作目录 {e.paths.workingDir} · 知识库 {e.paths.knowledgeDir} · 插件 {e.paths.pluginsDir}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          .env 兜底凭据：
          {data.envCreds.hasAuthToken ? " AUTH_TOKEN✓" : ""}
          {data.envCreds.hasApiKey ? " API_KEY✓" : ""}
          {!data.envCreds.hasAuthToken && !data.envCreds.hasApiKey ? " 无（必须配至少一个供应商）" : ""}
        </div>
      </div>
    </div>
  );
}

/**
 * Qoder 授权密钥输入。**只写不读**：服务端 GET 只报「有没有」，永不回显明文，
 * 所以这里不做「加载已有值」，只提供「保存 / 清除」，与供应商密钥同一口径。
 */
function QoderSecretField({
  kind,
  saved,
}: {
  kind: "accessToken" | "serviceAccount";
  saved: boolean;
}) {
  const [val, setVal] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (next: string) => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.setQoderSecret(kind, next);
      setVal("");
      setMsg(r.hasSecret ? "已保存（服务端已存密钥）" : "已清除");
    } catch (err) {
      setMsg(`失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label>
        {kind === "accessToken" ? "个人访问令牌" : "服务账号密钥"}
        <span className="hint">
          {saved ? "服务端已存有密钥（不回显）；填新值可覆盖" : "服务端尚未存密钥"}
        </span>
      </label>
      <div>
        <input
          type="password"
          value={val}
          placeholder={saved ? "已保存，留空则不改动" : "粘贴密钥"}
          onChange={(x) => setVal(x.target.value)}
        />
        <div className="hint">
          <button type="button" disabled={busy || !val.trim()} onClick={() => save(val.trim())}>
            保存密钥
          </button>
          {saved && (
            <>
              {" · "}
              <button type="button" disabled={busy} onClick={() => save("")}>
                清除
              </button>
            </>
          )}
          {msg && ` · ${msg}`}
        </div>
      </div>
    </>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="ovl-badge">{children}</span>;
}

// ─── 模型与凭据 ──────────────────────────────────────────
function ModelsTab() {
  const [data, setData] = useState<ProvidersResp | null>(null);
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [err, setErr] = useState<string>();

  const load = async () => setData(await api.providers());
  useEffect(() => {
    void load().catch((e) => setErr(String(e)));
  }, []);

  if (!data) return <div className="hint">加载中…</div>;

  const startNew = () => {
    setIsNew(true);
    setEditing({ id: "", name: "", authType: "auth_token", baseUrl: "", defaultModel: "" });
  };

  return (
    <div className="settings-form">
      {err && <div style={{ color: "var(--danger)" }}>⚠️ {err}</div>}
      <div className="settings-actions">
        <h3 style={{ margin: 0, flex: 1 }}>模型供应商</h3>
        <button className="primary" onClick={startNew}>
          + 新增供应商
        </button>
      </div>
      <div className="hint">
        供应商 = 一个 Anthropic 兼容网关。密钥只存不回显（掩码展示）；员工/主管在各自设置里引用它。
      </div>

      {data.providers.length === 0 && <div className="hint" style={{ marginTop: 12 }}>还没有供应商，点右上角新增。</div>}

      <div className="provider-list">
        {data.providers.map((p) => (
          <ProviderCard
            key={p.id}
            p={p}
            isDefault={data.defaultProviderId === p.id}
            onEdit={() => {
              setIsNew(false);
              setEditing(p);
            }}
            onChanged={() => void load()}
            onError={setErr}
          />
        ))}
      </div>

      {editing && (
        <ProviderEditor
          initial={editing}
          isNew={isNew}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
          onError={setErr}
        />
      )}
    </div>
  );
}

function ProviderCard({
  p,
  isDefault,
  onEdit,
  onChanged,
  onError,
}: {
  p: ProviderInfo;
  isDefault: boolean;
  onEdit: () => void;
  onChanged: () => void;
  onError: (s: string) => void;
}) {
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testProvider(p.id));
    } catch (e) {
      onError(String(e));
    } finally {
      setTesting(false);
    }
  };

  const del = async () => {
    if (!confirm(`删除供应商「${p.name}」？密钥也会一并清除。`)) return;
    try {
      await api.deleteProvider(p.id);
      onChanged();
    } catch (e) {
      // 被引用 → 409，提示强删
      const msg = String(e);
      if (msg.includes("409") && confirm(`${msg}\n\n仍要强制删除吗？`)) {
        await api.deleteProvider(p.id, true).then(onChanged).catch((x) => onError(String(x)));
      } else onError(msg);
    }
  };

  return (
    <div className="provider-card">
      <div className="pc-head">
        <span className="pc-name">{p.name}</span>
        <span className="pc-id">{p.id}</span>
        {isDefault && <span className="ovl-badge">默认</span>}
        <span className="spacer" />
        <button onClick={onEdit}>编辑</button>
        <button className="danger" onClick={() => void del()}>
          删除
        </button>
      </div>
      <div className="pc-meta hint">
        {p.authType} · {p.baseUrl || "(SDK 默认地址)"} · 模型 {p.defaultModel || "—"} · 密钥{" "}
        {p.hasSecret ? p.secretMask : "未配置"}
      </div>
      <div className="pc-test">
        <button onClick={() => void runTest()} disabled={testing || !p.hasSecret}>
          {testing ? "测试中…" : "测试连通性"}
        </button>
        {test && (
          <span style={{ color: test.ok ? "var(--success)" : "var(--danger)", marginLeft: 8 }}>
            {test.ok ? `✓ ${test.ms}ms · ${test.reply || test.model}` : `✗ ${test.error}`}
          </span>
        )}
      </div>
    </div>
  );
}

function ProviderEditor({
  initial,
  isNew,
  onClose,
  onSaved,
  onError,
}: {
  initial: ProviderInfo;
  isNew: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (s: string) => void;
}) {
  const [p, setP] = useState<ProviderInfo>(initial);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const patch = (x: Partial<ProviderInfo>) => setP((c) => ({ ...c, ...x }));

  const save = async () => {
    setSaving(true);
    try {
      if (isNew) {
        await api.createProvider({ ...p, ...(key ? { key } : {}) });
      } else {
        await api.updateProvider(p);
        if (key) await api.setProviderSecret(p.id, key);
      }
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="provider-editor">
      <h3>{isNew ? "新增供应商" : `编辑 · ${p.name}`}</h3>
      <label>
        id <span className="hint">{isNew ? "小写 slug，创建后不可改" : "锁定"}</span>
      </label>
      <input value={p.id} disabled={!isNew} onChange={(e) => patch({ id: e.target.value })} />

      <label>展示名</label>
      <input value={p.name} onChange={(e) => patch({ name: e.target.value })} />

      <label>
        网关地址 baseUrl <span className="hint">留空走官方默认；如 https://idealab.../v1</span>
      </label>
      <input value={p.baseUrl ?? ""} onChange={(e) => patch({ baseUrl: e.target.value })} />

      <label>
        鉴权类型 <span className="hint">代理网关多为 auth_token；官方为 api_key</span>
      </label>
      <select
        value={p.authType}
        onChange={(e) => patch({ authType: e.target.value as ProviderInfo["authType"] })}
      >
        <option value="auth_token">auth_token（ANTHROPIC_AUTH_TOKEN）</option>
        <option value="api_key">api_key（ANTHROPIC_API_KEY）</option>
      </select>

      <label>默认模型 defaultModel <span className="hint">引用此供应商且未单独指定模型时用</span></label>
      <input value={p.defaultModel ?? ""} onChange={(e) => patch({ defaultModel: e.target.value })} />

      <label>
        密钥 key{" "}
        <span className="hint">
          {p.hasSecret ? `已配置（${p.secretMask}），留空则不改` : "只写不回显"}
        </span>
      </label>
      <input
        type="password"
        value={key}
        placeholder={p.hasSecret ? "••••（留空保持不变）" : "粘贴密钥"}
        onChange={(e) => setKey(e.target.value)}
      />

      <div className="settings-actions">
        <button className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button onClick={onClose}>取消</button>
      </div>
    </div>
  );
}

// ─── 渠道与密钥 ──────────────────────────────────────────
/** 只写不回显的密钥输入行：已配置时展示掩码占位，留空即不改；可选申请地址链接 */
function SecretField({
  label,
  hint,
  link,
  status,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  link?: { url: string; text?: string };
  status?: CredentialStatus;
  value: string;
  onChange: (v: string) => void;
}) {
  const configured = status?.hasValue ?? false;
  return (
    <>
      <label>
        {label}{" "}
        <span className="hint">
          {configured
            ? `已配置（${status?.mask}${status?.fromEnvFallback ? " · 来自 .env" : ""}），留空则不改`
            : hint || "只写不回显"}
        </span>
        {link && (
          <>
            {" "}
            <a href={link.url} target="_blank" rel="noreferrer noopener">
              {link.text ?? "获取密钥 →"}
            </a>
          </>
        )}
      </label>
      <input
        type="password"
        value={value}
        placeholder={configured ? "••••（留空保持不变）" : "粘贴密钥"}
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  );
}

function ChannelsTab() {
  const [settings, setSettings] = useState<SettingsResp | null>(null);
  const [creds, setCreds] = useState<CredentialStatus[]>([]);
  const [clientId, setClientId] = useState("");
  const [robotCode, setRobotCode] = useState("");
  const [secret, setSecret] = useState("");
  const [tavily, setTavily] = useState("");
  const [exa, setExa] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState<string>("");
  const [savedAt, setSavedAt] = useState(0);
  const [restartMsg, setRestartMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    const [s, c] = await Promise.all([api.settings(), api.credentials()]);
    setSettings(s);
    setCreds(c.credentials);
    setClientId(s.effective.dingtalk.clientId ?? "");
    setRobotCode(s.effective.dingtalk.robotCode ?? "");
  };
  useEffect(() => {
    void load().catch((e) => setErr(String(e)));
  }, []);

  if (!settings) return <div className="hint">加载中…</div>;
  const e = settings.effective;
  const cred = (slot: string) => creds.find((c) => c.slot === slot);

  // 保存钉钉配置 + 密钥，再重连长连接
  const saveDingTalk = async () => {
    setBusy("dingtalk");
    setErr(undefined);
    setRestartMsg(null);
    try {
      const dingPatch: Record<string, string> = {};
      if (clientId !== (e.dingtalk.clientId ?? "")) dingPatch.clientId = clientId.trim();
      if (robotCode !== (e.dingtalk.robotCode ?? "")) dingPatch.robotCode = robotCode.trim();
      if (Object.keys(dingPatch).length) await api.saveSettings({ dingtalk: dingPatch });
      if (secret) await api.setCredential("dingtalk_client_secret", secret.trim());
      const r = await api.restartChannel("dingtalk");
      setRestartMsg(
        r.ok
          ? { ok: true, text: "已重连（看服务端日志确认 stream connected）" }
          : { ok: false, text: r.error || "重连失败" },
      );
      setSecret("");
      await load();
      setSavedAt(Date.now());
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setBusy("");
    }
  };

  const saveSearchKey = async (slot: string, value: string, clear: () => void) => {
    setBusy(slot);
    setErr(undefined);
    try {
      await api.setCredential(slot, value.trim());
      clear();
      await load();
      setSavedAt(Date.now());
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setBusy("");
    }
  };

  const overlaid = (k: string) => settings.overlayKeys.includes(k);

  return (
    <div className="settings-form">
      {err && <div style={{ color: "var(--danger)" }}>⚠️ {err}</div>}

      <h3>钉钉机器人（Stream 模式）</h3>
      <div className="hint">
        钉钉后台「消息接收模式」须选 <b>Stream 模式</b>（本服务不提供 HTTP 回调）。凭据可在此配，
        也可仍用 .env 兜底。改完点「保存并重连」让收消息的长连接用上新凭据。
        {!cred("dingtalk_client_secret")?.hasValue && !clientId && (
          <div style={{ marginTop: 6, color: "var(--warning, #b8860b)" }}>
            ⚠️ 当前未配置钉钉凭据，机器人不会连接。
          </div>
        )}
      </div>

      <label>
        AppKey（clientId） {overlaid("dingtalk") && <Badge>已覆盖</Badge>}
      </label>
      <input value={clientId} onChange={(x) => setClientId(x.target.value)} placeholder="企业内部机器人 AppKey" />

      <label>
        robotCode <span className="hint">留空 = 用 AppKey；后台单独建的机器人才需单独填</span>
      </label>
      <input value={robotCode} onChange={(x) => setRobotCode(x.target.value)} placeholder="留空回落 AppKey" />

      <SecretField
        label="AppSecret（clientSecret）"
        hint="钉钉开放平台 → 应用凭证与信息 里的 AppSecret"
        status={cred("dingtalk_client_secret")}
        value={secret}
        onChange={setSecret}
      />

      <div className="settings-actions">
        <button className="primary" onClick={() => void saveDingTalk()} disabled={busy === "dingtalk"}>
          {busy === "dingtalk" ? "保存并重连中…" : "保存并重连"}
        </button>
        <Saved at={savedAt} />
        {restartMsg && (
          <span style={{ color: restartMsg.ok ? "var(--success)" : "var(--danger)", marginLeft: 8 }}>
            {restartMsg.ok ? "✓ " : "✗ "}
            {restartMsg.text}
          </span>
        )}
      </div>

      <h3 style={{ marginTop: 28 }}>联网搜索密钥</h3>
      <div className="hint">
        填了才会挂载对应 MCP（下一个任务即生效，无需重启）。二选一即可；都不填则用内置免 key 的 websearch。
      </div>

      <SecretField
        label="Tavily API Key"
        hint="免费 1000 次/月，搜索 + 正文提取"
        link={{ url: "https://app.tavily.com", text: "去 app.tavily.com 申请 →" }}
        status={cred("tavily_api_key")}
        value={tavily}
        onChange={setTavily}
      />
      <div className="settings-actions">
        <button
          className="primary"
          onClick={() => void saveSearchKey("tavily_api_key", tavily, () => setTavily(""))}
          disabled={busy === "tavily_api_key"}
        >
          {busy === "tavily_api_key" ? "保存中…" : "保存"}
        </button>
      </div>

      <SecretField
        label="Exa API Key"
        hint="语义检索，注册送 $20、每月补 $10"
        link={{ url: "https://dashboard.exa.ai", text: "去 dashboard.exa.ai 申请 →" }}
        status={cred("exa_api_key")}
        value={exa}
        onChange={setExa}
      />
      <div className="settings-actions">
        <button
          className="primary"
          onClick={() => void saveSearchKey("exa_api_key", exa, () => setExa(""))}
          disabled={busy === "exa_api_key"}
        >
          {busy === "exa_api_key" ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}

// ─── 主管 ────────────────────────────────────────────────
function BossTab() {
  const [persona, setPersona] = useState<BossPersona | null>(null);
  const [presets, setPresets] = useState<BossPersonaPreset[]>([]);
  const [activePreset, setActivePreset] = useState<string>("");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [boss, setBoss] = useState<{ providerId: string; model: string }>({ providerId: "", model: "" });
  const [runtimeKind, setRuntimeKind] = useState<"vercel" | "qoder">("vercel");
  const [err, setErr] = useState<string>();
  const [savedAt, setSavedAt] = useState(0);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [b, p, s] = await Promise.all([api.boss(), api.providers(), api.settings()]);
    setPersona(b.persona);
    setPresets(b.presets ?? []);
    setActivePreset(b.activePresetId ?? "");
    setProviders(p.providers);
    setBoss({ providerId: s.effective.boss.providerId, model: s.effective.boss.model });
    setRuntimeKind(s.effective.runtimeKind);
  };
  useEffect(() => {
    void load().catch((e) => setErr(String(e)));
  }, []);

  if (!persona) return <div className="hint">加载中…</div>;
  const set = (x: Partial<BossPersona>) => setPersona((c) => ({ ...c!, ...x }));

  const switchPersona = async (id: string) => {
    if (!id) return;
    setErr(undefined);
    try {
      await api.setBossPersona(id);
      await load();
      setSavedAt(Date.now());
    } catch (e) {
      setErr(String(e));
    }
  };

  const save = async () => {
    setSaving(true);
    setErr(undefined);
    try {
      await api.saveBoss({
        name: persona.name,
        role: persona.role,
        personality: persona.personality,
        style: persona.style,
        team: persona.team,
        avatar: persona.avatar,
      });
      // 主管模型供应商归属通用设置覆盖层（boss.*）
      await api.saveSettings({ boss: { providerId: boss.providerId, model: boss.model } });
      await load();
      setSavedAt(Date.now());
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-form">
      {err && <div style={{ color: "var(--danger)" }}>⚠️ {err}</div>}
      {presets.length > 0 && (
        <>
          <h3>性格</h3>
          <label>
            预设{" "}
            <span className="hint">
              选中即生效，会覆盖下面的人设字段，并让主管当前的对话重新开始
            </span>
          </label>
          <select value={activePreset} onChange={(e) => void switchPersona(e.target.value)}>
            {!activePreset && <option value="">（自定义，未匹配任何预设）</option>}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}（{p.name}）
              </option>
            ))}
          </select>
          {activePreset && (
            <div className="hint">{presets.find((p) => p.id === activePreset)?.blurb}</div>
          )}
        </>
      )}
      <h3>主管人设</h3>
      <label>名字</label>
      <input value={persona.name} onChange={(e) => set({ name: e.target.value })} />
      <label>头衔 role</label>
      <input value={persona.role} onChange={(e) => set({ role: e.target.value })} />
      <label>性格 personality</label>
      <textarea value={persona.personality} onChange={(e) => set({ personality: e.target.value })} />
      <label>表达风格 style</label>
      <textarea value={persona.style} onChange={(e) => set({ style: e.target.value })} />
      <label>团队一句话 team <span className="hint">可选，实时名册会自动补充</span></label>
      <input value={persona.team ?? ""} onChange={(e) => set({ team: e.target.value })} />
      <label>头像 avatar <span className="hint">emoji 或图片 URL</span></label>
      <input value={persona.avatar ?? ""} onChange={(e) => set({ avatar: e.target.value })} />

      {/* 主管模型：qoder 模式不需要供应商/Anthropic 模型名，只用全局档位 */}
      {runtimeKind !== "qoder" && (
        <>
          <h3>主管模型</h3>
          <label>供应商 <span className="hint">主管的分诊/直答/验收调用；留空同全局默认</span></label>
          <select value={boss.providerId} onChange={(e) => setBoss((c) => ({ ...c, providerId: e.target.value }))}>
            <option value="">（同全局默认）</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.id}）
              </option>
            ))}
          </select>
          <label>模型覆盖 <span className="hint">留空用 routerModel / 供应商默认</span></label>
          <input value={boss.model} onChange={(e) => setBoss((c) => ({ ...c, model: e.target.value }))} />
        </>
      )}

      <div className="settings-actions">
        <button className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "保存中…" : "保存主管设置"}
        </button>
        <Saved at={savedAt} />
      </div>
    </div>
  );
}

// ─── MCP 管理 ───────────────────────────────────────────
/** 编辑器里 args / env / headers 都用多行文本编辑，避免为几个键值对做一整套动态表单 */
function linesToArray(s: string): string[] {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}
function linesToRecord(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    if (k) out[k] = line.slice(idx + 1).trim();
  }
  return out;
}
function recordToLines(r?: Record<string, string>): string {
  return Object.entries(r ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function McpTab() {
  const [data, setData] = useState<McpServersResp | null>(null);
  const [editing, setEditing] = useState<McpServerEntry | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [err, setErr] = useState<string>();

  const load = async () => setData(await api.mcpServers());
  useEffect(() => {
    void load().catch((e) => setErr(String(e)));
  }, []);

  if (!data) return <div className="hint">加载中…</div>;

  const startNew = () => {
    setIsNew(true);
    setEditing({
      name: "",
      scope: "optional",
      source: "user",
      decl: { type: "stdio", command: "" },
      missingEnv: [],
      refs: [],
    });
  };

  const del = async (s: McpServerEntry) => {
    if (!confirm(`删除 MCP「${s.name}」？`)) return;
    try {
      await api.deleteMcpServer(s.name);
      void load();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("409") && confirm(`${msg}\n\n仍要强制删除吗？`)) {
        await api.deleteMcpServer(s.name, true).then(load).catch((x) => setErr(String(x)));
      } else setErr(msg);
    }
  };

  return (
    <div className="settings-form">
      {err && <div style={{ color: "var(--danger)" }}>⚠️ {err}</div>}
      <div className="settings-actions">
        <h3 style={{ margin: 0, flex: 1 }}>MCP servers</h3>
        <button className="primary" onClick={startNew}>
          + 新增 MCP
        </button>
      </div>
      <div className="hint">
        <b>global</b> 全员默认挂载，<b>optional</b> 只有岗位在 <code>mcpServers</code> 里点名才挂（避免拖慢全体冷启动）。
        声明里可用 <code>${"{VAR}"}</code> 引用环境变量；<b>变量缺失的 server 会被静默剔除、根本不挂载</b>，下面会标出来。
        内置项只读，改 <code>{data.builtinFile}</code>。
      </div>

      <div className="provider-list">
        {data.servers.map((s) => (
          <div className="provider-card" key={`${s.scope}:${s.name}`}>
            <div className="pc-head">
              <span className="pc-name">{s.name}</span>
              <span className="pc-id">{s.scope}</span>
              {s.source === "builtin" && <span className="ovl-badge">内置</span>}
              {s.missingEnv.length > 0 && (
                <span className="ovl-badge" style={{ color: "var(--danger)" }}>
                  缺凭据·未挂载
                </span>
              )}
              <span className="spacer" />
              {s.source === "user" ? (
                <>
                  <button
                    onClick={() => {
                      setIsNew(false);
                      setEditing(s);
                    }}
                  >
                    编辑
                  </button>
                  <button className="danger" onClick={() => void del(s)}>
                    删除
                  </button>
                </>
              ) : (
                <span className="hint">只读</span>
              )}
            </div>
            <div className="pc-meta hint">
              {s.decl.type} ·{" "}
              {s.decl.type === "stdio"
                ? `${s.decl.command ?? ""} ${(s.decl.args ?? []).join(" ")}`.trim()
                : s.decl.url}
            </div>
            <div className="pc-meta hint">
              {s.missingEnv.length > 0 && (
                <span style={{ color: "var(--danger)" }}>
                  缺环境变量：{s.missingEnv.join("、")} ·{" "}
                </span>
              )}
              被点名：{s.refs.length > 0 ? s.refs.join("、") : "—"}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <McpEditor
          initial={editing}
          isNew={isNew}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
          onError={setErr}
        />
      )}
    </div>
  );
}

function McpEditor({
  initial,
  isNew,
  onClose,
  onSaved,
  onError,
}: {
  initial: McpServerEntry;
  isNew: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (s: string) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [scope, setScope] = useState<McpScope>(initial.scope);
  const [type, setType] = useState<McpServerDecl["type"]>(initial.decl.type);
  const [command, setCommand] = useState(initial.decl.command ?? "");
  const [args, setArgs] = useState((initial.decl.args ?? []).join("\n"));
  const [env, setEnv] = useState(recordToLines(initial.decl.env));
  const [url, setUrl] = useState(initial.decl.url ?? "");
  const [headers, setHeaders] = useState(recordToLines(initial.decl.headers));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const decl: McpServerDecl =
        type === "stdio"
          ? { type, command, args: linesToArray(args), env: linesToRecord(env) }
          : { type, url, headers: linesToRecord(headers) };
      const payload = { name, scope, decl };
      if (isNew) await api.createMcpServer(payload);
      else await api.updateMcpServer(payload);
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="provider-editor">
      <h3>{isNew ? "新增 MCP" : `编辑 · ${initial.name}`}</h3>
      <div className="grid2">
        <label>
          名称（会拼进工具名 mcp__&lt;name&gt;__&lt;tool&gt;）
          <input value={name} disabled={!isNew} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          挂载范围
          <select value={scope} onChange={(e) => setScope(e.target.value as McpScope)}>
            <option value="optional">optional · 岗位点名才挂</option>
            <option value="global">global · 全员默认挂载</option>
          </select>
        </label>
      </div>
      <label>
        连接方式
        <select value={type} onChange={(e) => setType(e.target.value as McpServerDecl["type"])}>
          <option value="stdio">stdio · 本地拉起进程</option>
          <option value="http">http · 远程</option>
          <option value="sse">sse · 远程</option>
        </select>
      </label>
      {type === "stdio" ? (
        <>
          <label>
            command
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </label>
          <label>
            args（一行一个）
            <textarea value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"-y\nsome-mcp-package"} />
          </label>
          <label>
            env（一行一个 KEY=value，可用 ${"{VAR}"} 引用环境变量）
            <textarea value={env} onChange={(e) => setEnv(e.target.value)} placeholder={"API_KEY=${SOME_API_KEY}"} />
          </label>
        </>
      ) : (
        <>
          <label>
            url
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
          </label>
          <label>
            headers（一行一个 KEY=value）
            <textarea
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={"Authorization=Bearer ${SOME_TOKEN}"}
            />
          </label>
        </>
      )}
      <div className="settings-actions">
        <button className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button onClick={onClose}>取消</button>
      </div>
    </div>
  );
}

// ─── 技能管理 ───────────────────────────────────────────
/** 剥掉 frontmatter，编辑器只编正文（frontmatter 由后端按 name/description 重新生成） */
function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (m ? m[1] : raw).trim();
}

/**
 * 从 SKILL.md 原文解析完整 description。
 * **不能用列表接口的 description 当编辑器初值**：那份被 listAvailableSkills 截到 200 字符
 * （只够列表展示），拿它保存会把原本 245~460 字符的 description 直接截掉。
 */
function parseFrontmatterDescription(raw: string): string | undefined {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!fm) return undefined;
  const line = fm.match(/^description:\s*(.*)$/m)?.[1];
  return line?.trim().replace(/^["']|["']$/g, "");
}

function SkillsTab() {
  const [data, setData] = useState<SkillsResp | null>(null);
  const [editing, setEditing] = useState<{ entry: SkillEntry; body: string } | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [err, setErr] = useState<string>();

  const load = async () => setData(await api.skills());
  useEffect(() => {
    void load().catch((e) => setErr(String(e)));
  }, []);

  if (!data) return <div className="hint">加载中…</div>;

  const startNew = () => {
    setIsNew(true);
    setEditing({
      entry: { name: "", description: "", ref: "", source: "user", chars: 0, declaredBy: [] },
      body: "",
    });
  };

  const openEdit = async (s: SkillEntry) => {
    try {
      const { raw } = await api.skillBody(s.ref);
      setIsNew(false);
      // description 用原文里的完整值，不用列表那份被截到 200 字符的
      setEditing({
        entry: { ...s, description: parseFrontmatterDescription(raw) ?? s.description },
        body: stripFrontmatter(raw),
      });
    } catch (e) {
      setErr(String(e));
    }
  };

  const del = async (s: SkillEntry) => {
    if (!confirm(`删除技能「${s.name}」？`)) return;
    try {
      await api.deleteSkill(s.name);
      void load();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("409") && confirm(`${msg}\n\n仍要强制删除吗？`)) {
        await api.deleteSkill(s.name, true).then(load).catch((x) => setErr(String(x)));
      } else setErr(msg);
    }
  };

  return (
    <div className="settings-form">
      {err && <div style={{ color: "var(--danger)" }}>⚠️ {err}</div>}
      <div className="settings-actions">
        <h3 style={{ margin: 0, flex: 1 }}>技能（Skills）</h3>
        <button className="primary" onClick={startNew}>
          + 新增技能
        </button>
      </div>
      <div className="hint">
        技能按三级渐进披露消费：岗位在 <code>skills</code> 里<b>声明</b>的会把正文预载进 system；
        其余只在 system 里留「名称 + 说明」清单，模型判断相关时用 <code>Skill</code> 工具按需取正文。
        所以 <b>description 要写清「什么时候该用」</b>——模型只靠它决定加不加载。
        内置项只读，改 <code>{data.builtinDir}</code>。
      </div>

      <div className="provider-list">
        {data.skills.map((s) => (
          <div className="provider-card" key={s.ref}>
            <div className="pc-head">
              <span className="pc-name">{s.name}</span>
              <span className="pc-id">{s.ref}</span>
              {s.source === "builtin" && <span className="ovl-badge">内置</span>}
              {s.declaredBy.length > 0 && <span className="ovl-badge">预载</span>}
              <span className="spacer" />
              <button onClick={() => void openEdit(s)}>
                {s.source === "builtin" ? "查看" : "编辑"}
              </button>
              {s.source === "user" && (
                <button className="danger" onClick={() => void del(s)}>
                  删除
                </button>
              )}
            </div>
            <div className="pc-meta hint">{s.description || "（没写 description，模型无法判断是否该加载）"}</div>
            <div className="pc-meta hint">
              {s.chars} 字符（≈{Math.round(s.chars / 3)} token） · 声明预载：
              {s.declaredBy.length > 0 ? s.declaredBy.join("、") : "无（仅按需加载）"}
            </div>
          </div>
        ))}
      </div>

      <ExternalSkillImport onImported={() => void load()} onError={setErr} />

      {editing && (
        <SkillEditor
          initial={editing}
          isNew={isNew}
          readOnly={!isNew && editing.entry.source === "builtin"}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
          onError={setErr}
        />
      )}
    </div>
  );
}

function SkillEditor({
  initial,
  isNew,
  readOnly,
  onClose,
  onSaved,
  onError,
}: {
  initial: { entry: SkillEntry; body: string };
  isNew: boolean;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (s: string) => void;
}) {
  const [name, setName] = useState(initial.entry.name);
  const [description, setDescription] = useState(initial.entry.description);
  const [body, setBody] = useState(initial.body);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const payload = { name, description, body };
      if (isNew) await api.createSkill(payload);
      else await api.updateSkill(payload);
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="provider-editor">
      <h3>
        {isNew ? "新增技能" : readOnly ? `查看 · ${initial.entry.name}（内置只读）` : `编辑 · ${initial.entry.name}`}
      </h3>
      <label>
        名称（也是目录名与引用名的后半段）
        <input value={name} disabled={!isNew} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        description —— 模型只靠这句判断要不要加载，写清「什么场景该用」
        <textarea
          value={description}
          disabled={readOnly}
          onChange={(e) => setDescription(e.target.value)}
          style={{ minHeight: 48 }}
        />
      </label>
      <label>
        正文（Markdown，不含 frontmatter）
        <textarea
          value={body}
          disabled={readOnly}
          onChange={(e) => setBody(e.target.value)}
          style={{ minHeight: 280, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
        />
      </label>
      <div className="settings-actions">
        {!readOnly && (
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        )}
        <button onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}

/**
 * 从外部目录导入 skill。
 *
 * `~/.claude/skills` / `~/.qoder/skills` 这些目录**不参与运行时扫描**——实测有 50 个，
 * 全进 L1 清单会给每个 agent 白加数千 token 噪音。所以这里做成显式的按需导入。
 * 默认折叠：候选很多，展开才拉数据。
 */
function ExternalSkillImport({
  onImported,
  onError,
}: {
  onImported: () => void;
  onError: (s: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ExternalSkillsResp | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string>();

  const load = async () => setData(await api.externalSkills());

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data) void load().catch((e) => onError(String(e)));
  };

  const doImport = async (name: string) => {
    setBusy(name);
    try {
      const r = await api.importSkill(name);
      if (r.extras.length > 0) {
        alert(
          `已导入 ${r.name}。\n\n注意：它还带了 ${r.extras.join("、")} 等附带文件，` +
            `本系统不会自动把这些内容注入上下文——只有 SKILL.md 正文里写了绝对路径、模型自己去读才拿得到。`,
        );
      }
      await load();
      onImported();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const shown = (data?.skills ?? []).filter(
    (s) =>
      !filter ||
      s.name.toLowerCase().includes(filter.toLowerCase()) ||
      s.description.toLowerCase().includes(filter.toLowerCase()),
  );
  const pending = shown.filter((s) => !s.imported);

  return (
    <div className="ext-import">
      <div className="settings-actions">
        <button onClick={toggle}>
          {open ? "▾" : "▸"} 从外部目录导入
          {data ? ` （${data.skills.filter((s) => !s.imported).length} 个可导入）` : ""}
        </button>
      </div>
      {open && (
        <>
          <div className="hint">
            扫描其他 coding agent 的全局 skill 目录：
            {(data?.roots ?? []).map((r) => (
              <code key={r} style={{ marginLeft: 6 }}>
                {r}
              </code>
            ))}
            。这些目录<b>不参与运行时扫描</b>（几十个 skill 全进上下文清单会淹掉真正相关的），
            要用哪个就导入哪个 —— 导入 = 整目录复制进用户 skill 目录。
          </div>
          {!data ? (
            <div className="hint">加载中…</div>
          ) : (
            <>
              <input
                placeholder="按名称 / 说明过滤"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ marginTop: 8 }}
              />
              <div className="ext-list">
                {pending.length === 0 && <div className="hint">没有可导入的（都导入过了或没匹配到）。</div>}
                {pending.map((s) => (
                  <div className="ext-row" key={`${s.root}:${s.name}`}>
                    <div className="ext-row-main">
                      <span className="pc-name">{s.name}</span>
                      <span className="pc-id">{s.root.includes(".claude") ? ".claude" : ".qoder"}</span>
                      {s.extras.length > 0 && (
                        <span className="hint" style={{ marginLeft: 6 }}>
                          +{s.extras.length} 个附件
                        </span>
                      )}
                      <div className="hint ext-desc">{s.description || "（无 description，模型无法判断何时该用）"}</div>
                    </div>
                    <button
                      className="primary"
                      disabled={busy === s.name}
                      onClick={() => void doImport(s.name)}
                    >
                      {busy === s.name ? "导入中…" : "导入"}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── 团队配置分享 ────────────────────────────────────────
function TeamConfigTab({ onGoMcp }: { onGoMcp: () => void }) {
  const [exportName, setExportName] = useState("");
  const [scope, setScope] = useState<"full" | "employees">("full");
  const [agentIds, setAgentIds] = useState("");
  const [includeBoss, setIncludeBoss] = useState(true);
  const [includeSkills, setIncludeSkills] = useState(true);
  const [includeMcps, setIncludeMcps] = useState(true);
  const [preview, setPreview] = useState<TeamExportPreview>();
  const [download, setDownload] = useState<{ filename: string; url: string }>();
  const [importView, setImportView] = useState<TeamImportView>();
  const [mode, setMode] = useState<TeamImportMode>("add_employees");
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [conflictPolicy, setConflictPolicy] = useState<"keep" | "replace">("keep");
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [history, setHistory] = useState<{ imports: any[]; snapshots: any[] }>({ imports: [], snapshots: [] });
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [result, setResult] = useState<any>();

  const loadHistory = () => api.teamBundleHistory().then(setHistory).catch((e) => setErr(String(e)));
  useEffect(() => { void loadHistory(); }, []);

  const exportOptions = () => ({
    kind: scope,
    ...(exportName.trim() ? { name: exportName.trim() } : {}),
    ...(scope === "employees"
      ? { agentIds: agentIds.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) }
      : {}),
    includeBoss: scope === "full" ? includeBoss : false,
    includeSkills,
    includeMcps,
  });

  const doPreview = async () => {
    setBusy("preview"); setErr(undefined);
    try { setPreview(await api.previewTeamExport(exportOptions())); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(undefined); }
  };
  const doExport = async () => {
    setBusy("export"); setErr(undefined);
    try {
      const out = await api.createTeamExport(exportOptions());
      setDownload({ filename: out.filename, url: out.downloadUrl });
      setPreview(await api.previewTeamExport(exportOptions()));
    } catch (e) { setErr(String(e)); }
    finally { setBusy(undefined); }
  };

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy("upload"); setErr(undefined); setResult(undefined);
    try {
      const view = await api.uploadTeamImport(file);
      setImportView(view);
      setMode("add_employees");
      setSelectedAgents(view.inspection.package.agents.map((a) => a.id));
      setConflictPolicy("keep");
      setReplaceConfirmed(false);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(undefined); }
  };

  const applyImport = async () => {
    if (!importView) return;
    if (mode === "replace_team" && !replaceConfirmed) {
      setErr("整体覆盖前请勾选确认说明");
      return;
    }
    const base = structuredClone(importView.inspection.defaultPlans[mode]) as TeamImportPlan;
    base.selectedAgents = selectedAgents;
    base.includeBoss = mode === "add_employees" ? false : base.includeBoss;
    for (const c of Object.values(base.agentConflicts)) c.action = conflictPolicy;
    for (const c of Object.values(base.skillConflicts)) c.action = conflictPolicy;
    for (const c of Object.values(base.mcpConflicts)) c.action = conflictPolicy;
    if (!confirm(
      mode === "replace_team"
        ? "确认整体覆盖可分享层？本地模型、Provider、Token/Key 和渠道设置不会改变。"
        : `确认执行${mode === "merge" ? "合并团队" : "添加员工"}？`,
    )) return;
    setBusy("apply"); setErr(undefined);
    try {
      await api.updateTeamImportPlan(importView.record.id, base);
      // 界面上那个危险勾选就是用户的覆盖意图，必须带到服务端换 elevated 令牌 ——
      // 只在前端拦一下等于没拦（改计划后普通令牌也执行不了覆盖，这是服务端的独立防线）
      const confirmation = await api.confirmTeamImport(
        importView.record.id,
        mode === "replace_team" && replaceConfirmed,
      );
      const out = await api.applyTeamImport(importView.record.id, confirmation.token);
      setResult(out);
      await loadHistory();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(undefined); }
  };

  const rollback = async (id: string) => {
    if (!confirm(`确认回滚到快照 ${id}？当前状态会先自动保存为新的安全快照。`)) return;
    setBusy(`rollback:${id}`); setErr(undefined);
    try {
      const out = await api.rollbackTeamSnapshot(id);
      setResult({ rollback: id, safetySnapshotId: out.safetySnapshotId });
      await loadHistory();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(undefined); }
  };

  const packageInfo = importView?.inspection.package;
  return (
    <div className="team-config-tab">
      <section className="team-bundle-section">
        <h3>分享团队</h3>
        <p className="hint">只分享 Boss 人设、员工能力、用户 Skill 和 MCP 结构。模型、Provider、Token/Key、本机路径和运行数据永不进入文件；MCP 的凭据只带占位符，公开常量会原样带出（导出前逐条列给你确认）。</p>
        <div className="team-bundle-grid">
          <label>团队名称<input value={exportName} onChange={(e) => setExportName(e.target.value)} placeholder="留空使用当前 Boss 名称" /></label>
          <label>导出范围<select value={scope} onChange={(e) => { const next = e.target.value as typeof scope; setScope(next); setIncludeBoss(next === "full"); }}><option value="full">完整团队</option><option value="employees">指定员工</option></select></label>
        </div>
        {scope === "employees" && <label>员工路由 ID <span className="hint">逗号或空格分隔</span><input value={agentIds} onChange={(e) => setAgentIds(e.target.value)} placeholder="coder researcher" /></label>}
        <div className="team-checks">
          <label><input type="checkbox" checked={includeBoss} disabled={scope === "employees"} onChange={(e) => setIncludeBoss(e.target.checked)} /> Boss 人设</label>
          <label><input type="checkbox" checked={includeSkills} onChange={(e) => setIncludeSkills(e.target.checked)} /> 用户 Skill</label>
          <label><input type="checkbox" checked={includeMcps} onChange={(e) => setIncludeMcps(e.target.checked)} /> MCP 结构</label>
        </div>
        <div className="settings-actions">
          <button disabled={Boolean(busy)} onClick={() => void doPreview()}>{busy === "preview" ? "检查中…" : "预览"}</button>
          <button className="primary" disabled={Boolean(busy)} onClick={() => void doExport()}>{busy === "export" ? "导出中…" : "生成 .ait-team"}</button>
          {download && <a className="team-download" href={download.url} download={download.filename}>下载 {download.filename}</a>}
        </div>
        {preview && (
          <div className="team-preview">
            <b>{preview.filename}</b> · {preview.agents.length} 名员工 · {preview.skills.length} 个 Skill · {preview.mcps.length} 个 MCP · {Math.ceil(preview.compressedBytes / 1024)}KB
            <div className="hint">排除：{preview.security.excluded.join("、")}</div>
            {preview.security.warnings.length > 0 && <div className="warn-text">{preview.security.warnings.join("；")}</div>}
            {/*
              这块必须始终渲染（哪怕清单为空）：只在有内容时才出现的话，用户看不到清单时
              分不清「确实没有原样带出的值」和「界面漏了这块」。这是分级判定唯一的确定性防线。
            */}
            <div className="team-literals">
              <div className="team-literals-head">
                会原样写进包里的 MCP 公开常量（{preview.carriedLiterals?.length ?? 0} 项）
              </div>
              {preview.carriedLiterals?.length ? (
                <>
                  <div className="warn-text">
                    请逐条确认都不是凭据。如果其中有敏感值，先把本机 MCP 里那一项改成 ${"{VAR}"} 形式（从 .env 取），再重新导出。
                  </div>
                  <ul>
                    {preview.carriedLiterals.map((l, i) => (
                      <li key={`${l.mcp}-${l.target}-${l.key}-${i}`}>
                        <code>{l.mcp}.{l.target}.{l.key}</code> = <code>{l.value}</code>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="hint">本次没有原样带出的值（全部 MCP 字段都被判为凭据或不含值）。</div>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="team-bundle-section">
        <h3>导入团队</h3>
        <p className="hint">上传后只做检查，不会立即修改团队。应用前会创建快照，整体覆盖有二次确认。</p>
        <label className="team-file-drop"><input type="file" accept=".ait-team" onChange={(e) => void upload(e.target.files?.[0])} />{busy === "upload" ? "正在检查…" : "选择 .ait-team 文件"}</label>
        {importView && packageInfo && (
          <div className="team-import-panel">
            <h4>{packageInfo.meta.name}</h4>
            <div>{packageInfo.agents.length} 名员工 · {packageInfo.skills.length} 个 Skill · {packageInfo.mcps.length} 个 MCP{packageInfo.boss ? ` · Boss「${packageInfo.boss.name}」` : ""}</div>
            {!importView.inspection.compatible && <div className="error">{importView.inspection.errors.join("；")}</div>}
            <label>导入方式<select value={mode} onChange={(e) => { setMode(e.target.value as TeamImportMode); setReplaceConfirmed(false); }}><option value="add_employees">只添加员工</option><option value="merge">合并团队</option><option value="replace_team">整体覆盖可分享层</option></select></label>
            <div className="team-agent-select"><b>员工</b>{packageInfo.agents.map((a) => <label key={a.id}><input type="checkbox" checked={selectedAgents.includes(a.id)} onChange={(e) => setSelectedAgents((old) => e.target.checked ? [...old, a.id] : old.filter((id) => id !== a.id))} /> {a.displayName || a.id} <span className="hint">({a.id})</span></label>)}</div>
            <label>同名冲突<select value={conflictPolicy} onChange={(e) => setConflictPolicy(e.target.value as typeof conflictPolicy)}><option value="keep">保留本地（推荐）</option><option value="replace">使用导入配置，但保留本地模型和绑定</option></select></label>
            {importView.inspection.requiredBindings.length > 0 && <div className="warn-text">有 {importView.inspection.requiredBindings.length} 个 MCP 本机绑定不会从包中导入。应用后请到 MCP 页填写。 <button onClick={onGoMcp}>打开 MCP</button></div>}
            {mode === "replace_team" && <label className="danger-check"><input type="checkbox" checked={replaceConfirmed} onChange={(e) => setReplaceConfirmed(e.target.checked)} /> 我确认归档当前可分享团队结构并整体覆盖；模型、凭据和渠道设置保持不变。</label>}
            <button className={mode === "replace_team" ? "danger" : "primary"} disabled={Boolean(busy) || !importView.inspection.compatible} onClick={() => void applyImport()}>{busy === "apply" ? "应用中…" : mode === "replace_team" ? "确认整体覆盖" : "确认导入"}</button>
          </div>
        )}
        {result && <pre className="team-result">{JSON.stringify(result, null, 2)}</pre>}
      </section>

      <section className="team-bundle-section">
        <h3>快照与回滚</h3>
        {history.snapshots.length === 0 ? <div className="hint">暂无快照</div> : history.snapshots.slice(0, 10).map((s) => <div className="team-history-row" key={s.id}><div><b>{s.reason}</b><div className="hint">{new Date(s.createdAt).toLocaleString()} · {s.id}</div></div><button disabled={Boolean(busy)} onClick={() => void rollback(s.id)}>{busy === `rollback:${s.id}` ? "回滚中…" : "回滚"}</button></div>)}
      </section>
      {err && <div className="error settings-error">{err}</div>}
    </div>
  );
}
