import { useEffect, useState } from "react";
import { Avatar, faceOf } from "../agent-face";
import { api } from "../api";
import { QoderModelPicker } from "./QoderModelPicker";
import type { AgentProfile, ProviderInfo, SopStep, ToolCatalog, WorkspacePolicy } from "../types";

const HIGH_PRIV = new Set(["Write", "Edit", "Bash", "Task", "TodoWrite"]);

interface Props {
  initial: AgentProfile | null; // null = 新建
  isNew: boolean;
  catalog: ToolCatalog | null;
  employeeIds: string[]; // 可选下属列表
  builtinIds: string[]; // 保留字，新建时校验
  onSave: (cfg: AgentProfile) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}

const EMPTY: AgentProfile = {
  id: "",
  displayName: "",
  description: "",
  type: "simple",
  systemPrompt: "",
  maxThinkingTokens: 5000,
  workspace: "auto",
  workspacePolicy: "shared",
  tools: ["Read", "Grep", "Glob"],
};

export function AgentEditor({
  initial,
  isNew,
  catalog,
  employeeIds,
  builtinIds,
  onSave,
  onCancel,
  onDelete,
}: Props) {
  const [cfg, setCfg] = useState<AgentProfile>(initial ?? EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => setCfg(initial ?? EMPTY), [initial]);

  // 当前进程的 runtime：决定这个员工的模型字段是「自由文本」还是「Qoder 档位下拉」
  const [runtimeKind, setRuntimeKind] = useState<"vercel" | "qoder">("vercel");
  useEffect(() => {
    void api
      .settings()
      .then((r) => setRuntimeKind(r.effective.runtimeKind))
      .catch(() => {});
  }, []);
  const isQoder = runtimeKind === "qoder";

  const patch = (p: Partial<AgentProfile>) => setCfg((c) => ({ ...c, ...p }));

  const validate = (): string | undefined => {
    if (isNew) {
      if (!/^[a-z][a-z0-9_-]{1,39}$/.test(cfg.id)) return "id 非法（小写字母开头，2-40 位，字母/数字/-/_）";
      if (builtinIds.includes(cfg.id)) return `id 与内置岗位冲突: ${cfg.id}`;
    }
    if (!cfg.displayName.trim()) return "displayName（展示名）不能为空";
    if (!cfg.description.trim()) return "description 不能为空";
    if (!cfg.systemPrompt.trim()) return "systemPrompt 不能为空";
    if (cfg.type === "sop") {
      if (!cfg.steps?.length) return "SOP 至少要一步";
      const seen = new Set<string>();
      for (const s of cfg.steps) {
        if (!s.id.trim()) return "步骤 id 不能为空";
        if (seen.has(s.id)) return `步骤 id 重复: ${s.id}`;
        seen.add(s.id);
        if (!s.title.trim()) return `步骤 ${s.id} 缺 title`;
        if (!s.prompt.trim()) return `步骤 ${s.id} 缺 prompt`;
        if (s.mode === "delegate" && !s.delegate?.trim())
          return `步骤 ${s.id} 是 delegate 但未指定下属`;
      }
    }
    // 高权限工具二次确认
    const highPriv = (cfg.tools ?? []).filter((t) => HIGH_PRIV.has(t));
    if (highPriv.length > 0 && !cfg["_confirmedHighPriv" as unknown as keyof AgentProfile]) {
      if (!confirm(
        `确认要给该员工授予高权限工具吗？\n\n${highPriv.join(", ")}\n\n这些工具能改文件/执行命令，请确保任务范围可控。`,
      )) {
        return "已取消：需要确认高权限工具授予";
      }
    }
    return undefined;
  };

  const doSave = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(undefined);
    setSaving(true);
    try {
      await onSave(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h3>{isNew ? "新增员工" : `编辑 · ${cfg.displayName}`}</h3>
      {error && (
        <div style={{ color: "var(--danger)", marginTop: 8 }}>⚠️ {error}</div>
      )}

      <label>
        id{" "}
        <span className="hint">
          {isNew ? "创建后不可改" : "锁定，避免破坏历史任务引用"}
        </span>
      </label>
      <input
        value={cfg.id}
        disabled={!isNew}
        onChange={(e) => patch({ id: e.target.value })}
      />

      <label>展示名</label>
      <input value={cfg.displayName} onChange={(e) => patch({ displayName: e.target.value })} />

      <label>
        头像 <span className="hint">一个 emoji（如 🐯）或图片 URL；留空用默认头像</span>
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          value={cfg.avatar ?? ""}
          placeholder="🐯 或 https://…/avatar.png"
          onChange={(e) => patch({ avatar: e.target.value })}
        />
        <Avatar face={faceOf(cfg.id, cfg.avatar, cfg.type ?? "simple")} size={34} />
      </div>

      <label>
        描述 <span className="hint">写清"什么任务派给他"，决定路由准确度</span>
      </label>
      <input
        value={cfg.description}
        onChange={(e) => patch({ description: e.target.value })}
      />

      <label>
        类型
      </label>
      <select
        value={cfg.type ?? "simple"}
        onChange={(e) => {
          const t = e.target.value as "simple" | "sop";
          patch({
            type: t,
            steps: t === "sop" ? cfg.steps ?? [] : undefined,
          });
        }}
      >
        <option value="simple">simple（单轮 prompt 型）</option>
        <option value="sop">sop（SOP 小组长）</option>
      </select>

      <label>
        系统提示词{" "}
        <span className="hint">
          {cfg.type === "sop" ? "小组长主上下文（角色/验收基调/汇报口径）；具体步骤在下面写" : "完整干活提示词"}
        </span>
      </label>
      <textarea
        value={cfg.systemPrompt}
        rows={cfg.type === "sop" ? 6 : 10}
        onChange={(e) => patch({ systemPrompt: e.target.value })}
      />

      {cfg.type === "sop" && (
        <StepsEditor
          steps={cfg.steps ?? []}
          employeeIds={employeeIds}
          onChange={(steps) => patch({ steps })}
        />
      )}

      {/* 模型体系按 runtime 二选一：两套字段同时露出会让人不知道到底哪个生效 */}
      {isQoder ? (
        <>
          <label>
            模型档位 <span className="hint">留空继承全局默认档位</span>
          </label>
          <QoderModelPicker
            value={cfg.qoderModel ?? ""}
            onChange={(v) => patch({ qoderModel: v || undefined })}
            placeholder="留空 = 继承全局默认档位"
          />
        </>
      ) : (
        <>
          <label>模型 <span className="hint">留空用全局默认</span></label>
          <input
            value={cfg.model ?? ""}
            onChange={(e) => patch({ model: e.target.value || undefined })}
          />

          <ProviderPicker value={cfg.provider} onChange={(provider) => patch({ provider })} />
        </>
      )}

      <label>思考额度 (maxThinkingTokens)</label>
      <input
        type="number"
        value={cfg.maxThinkingTokens ?? 5000}
        onChange={(e) => patch({ maxThinkingTokens: Number(e.target.value) })}
      />

      <label>最大轮次 (maxTurns) <span className="hint">可选</span></label>
      <input
        type="number"
        value={cfg.maxTurns ?? ""}
        onChange={(e) => patch({ maxTurns: e.target.value ? Number(e.target.value) : undefined })}
      />

      <label>
        workspace 策略{" "}
        <span className="hint">授高权限工具建议 per-chat；要开并发用 per-task；只读岗位 shared 即可</span>
      </label>
      <select
        value={cfg.workspacePolicy ?? "shared"}
        onChange={(e) => patch({ workspacePolicy: e.target.value as WorkspacePolicy })}
      >
        <option value="shared">shared（共享目录）</option>
        <option value="per-chat">per-chat（会话分桶且持久）</option>
        <option value="per-task">per-task（任务分桶且持久，开影分身必选）</option>
        <option value="per-run">per-run（每次临时目录，用完即弃）</option>
      </select>

      <label>
        🌀 影分身 <span className="hint">同时能开几个分身各干一件活；留空 = 不开（一次只干一件）。大于 1 必须选 per-task，每个分身要有独立工作目录</span>
      </label>
      <input
        type="number"
        min={1}
        value={cfg.maxParallel ?? ""}
        onChange={(e) => {
          const n = e.target.value ? Number(e.target.value) : undefined;
          // 1 是默认值，不落库——配置里留一个等于默认的字段只会让人以为「这里特意设过」
          patch({ maxParallel: n && n > 1 ? n : undefined });
        }}
      />

      {catalog && <ToolsSelector cfg={cfg} catalog={catalog} onChange={(tools) => patch({ tools })} />}

      <label>复盘沉淀 <span className="hint">长期迭代型岗位开启</span></label>
      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
        <input
          type="checkbox"
          style={{ width: "auto" }}
          checked={cfg.retro?.enabled ?? false}
          onChange={(e) =>
            patch({ retro: e.target.checked ? { enabled: true } : { enabled: false } })
          }
        />
        参与复盘
      </label>

      <div className="actions">
        <button className="primary" onClick={doSave} disabled={saving}>
          {saving ? "保存中…" : isNew ? "创建" : "保存"}
        </button>
        <button onClick={onCancel}>取消</button>
        {!isNew && onDelete && (
          <button
            className="danger"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              if (confirm(`确认删除员工「${cfg.displayName}」(${cfg.id}) 吗？`)) void onDelete();
            }}
          >
            删除
          </button>
        )}
      </div>
    </div>
  );
}

function ToolsSelector({
  cfg,
  catalog,
  onChange,
}: {
  cfg: AgentProfile;
  catalog: ToolCatalog;
  onChange: (tools: string[]) => void;
}) {
  const selected = new Set(cfg.tools ?? []);
  const toggle = (t: string) => {
    const next = new Set(selected);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    onChange([...next]);
  };
  return (
    <>
      <label>
        工具白名单{" "}
        <span className="hint">
          只读档默认；高权限（黄框）授予前会二次确认
        </span>
      </label>
      <div style={{ marginTop: 4 }}>
        {catalog.readonly.map((t) => (
          <span
            key={t}
            className={`tool-chip ${selected.has(t) ? "selected" : ""}`}
            onClick={() => toggle(t)}
          >
            {t}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 4 }}>
        {catalog.highPriv.map((t) => (
          <span
            key={t}
            className={`tool-chip high-priv ${selected.has(t) ? "selected" : ""}`}
            onClick={() => toggle(t)}
          >
            ⚠️ {t}
          </span>
        ))}
      </div>
      {catalog.mcp.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {catalog.mcp.map((t) => (
            <span
              key={t}
              className={`tool-chip ${selected.has(t) ? "selected" : ""}`}
              onClick={() => toggle(t)}
            >
              🔌 {t}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function StepsEditor({
  steps,
  employeeIds,
  onChange,
}: {
  steps: SopStep[];
  employeeIds: string[];
  onChange: (steps: SopStep[]) => void;
}) {
  const patch = (idx: number, p: Partial<SopStep>) => {
    onChange(steps.map((s, i) => (i === idx ? { ...s, ...p } : s)));
  };
  const remove = (idx: number) => onChange(steps.filter((_, i) => i !== idx));
  const add = () =>
    onChange([
      ...steps,
      { id: `step${steps.length + 1}`, title: "", mode: "self", prompt: "" },
    ]);
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  return (
    <>
      <label>
        SOP 步骤{" "}
        <span className="hint">
          {"顺序即依赖；prompt 里可写 {{input}} / {{step:xxx}} / {{param.xxx}}"}
        </span>
      </label>
      {steps.map((s, i) => (
        <div key={i} className="step-card">
          <div className="step-head">
            <input
              placeholder="stepId"
              value={s.id}
              onChange={(e) => patch(i, { id: e.target.value })}
              style={{ maxWidth: 120 }}
            />
            <input
              placeholder="标题"
              value={s.title}
              onChange={(e) => patch(i, { title: e.target.value })}
            />
            <select
              value={s.mode ?? "self"}
              onChange={(e) => patch(i, { mode: e.target.value as "self" | "delegate" })}
              style={{ width: 110 }}
            >
              <option value="self">self</option>
              <option value="delegate">delegate</option>
            </select>
            <button onClick={() => move(i, -1)} title="上移">↑</button>
            <button onClick={() => move(i, 1)} title="下移">↓</button>
            <button className="danger" onClick={() => remove(i)}>删</button>
          </div>
          {s.mode === "delegate" && (
            <>
              <label>受派下属</label>
              <select
                value={s.delegate ?? ""}
                onChange={(e) => patch(i, { delegate: e.target.value })}
              >
                <option value="">选择员工…</option>
                {employeeIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <label>
                验收标准 (accept){" "}
                <span className="hint">强烈建议填，"什么算达标"</span>
              </label>
              <textarea
                rows={2}
                value={s.accept ?? ""}
                onChange={(e) => patch(i, { accept: e.target.value })}
              />
              <label>验收失败最大重试次数 (maxRetries)</label>
              <input
                type="number"
                value={s.maxRetries ?? 2}
                onChange={(e) => patch(i, { maxRetries: Number(e.target.value) })}
              />
            </>
          )}
          <label>
            指令 (prompt){" "}
            <span className="hint">
              {"支持 {{input}} / {{step:<前序id>}} / {{param.xxx}}"}
            </span>
          </label>
          <textarea
            rows={3}
            value={s.prompt}
            onChange={(e) => patch(i, { prompt: e.target.value })}
          />
        </div>
      ))}
      <button style={{ marginTop: 8 }} onClick={add}>+ 加一步</button>
    </>
  );
}

/** 员工独立模型供应商选择：留空=继承全局默认；选中后可行内覆盖模型 */
function ProviderPicker({
  value,
  onChange,
}: {
  value?: { id?: string; model?: string; baseUrl?: string };
  onChange: (v: AgentProfile["provider"]) => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [defaultId, setDefaultId] = useState("");
  useEffect(() => {
    void api
      .providers()
      .then((r) => {
        setProviders(r.providers);
        setDefaultId(r.defaultProviderId);
      })
      .catch(() => {});
  }, []);

  const v = value ?? {};
  const set = (p: Partial<NonNullable<AgentProfile["provider"]>>) => {
    const next = { ...v, ...p };
    // 全空则清除整段（回到继承全局）
    if (!next.id && !next.model && !next.baseUrl) onChange(undefined);
    else onChange(next);
  };
  const defName = providers.find((x) => x.id === defaultId)?.name;

  return (
    <>
      <label>
        模型供应商{" "}
        <span className="hint">
          留空继承全局默认{defName ? `（当前：${defName}）` : "（.env 兜底）"}；到「设置 · 模型与凭据」维护供应商
        </span>
      </label>
      <select value={v.id ?? ""} onChange={(e) => set({ id: e.target.value || undefined })}>
        <option value="">（继承全局默认）</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}（{p.id}）
          </option>
        ))}
      </select>
      {v.id && (
        <>
          <label>该员工模型覆盖 <span className="hint">留空用供应商默认模型</span></label>
          <input
            value={v.model ?? ""}
            onChange={(e) => set({ model: e.target.value || undefined })}
          />
        </>
      )}
    </>
  );
}
