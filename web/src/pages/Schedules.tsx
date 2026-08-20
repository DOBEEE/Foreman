import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ScheduleEntry, SchedulesResp } from "../types";

/**
 * 定时任务管理 —— **全局视图**（跨所有会话）。
 *
 * 主管的 list_schedules 只列「当前会话」的定时任务（在群里全局列出会把用户私聊的定时
 * 任务念给全群，是泄露），代价是用户失去了跨会话的全貌：落在旧会话里的任务会变成
 * 「看不见、管不了，却每天照推」。这一页就是补这个缺口，所以每条都显式标出投递目标。
 */

/** j<T>() 抛的是 `409: {"error":"…"}`；剥出人类可读部分再进 confirm() */
function errText(e: unknown): string {
  const raw = String(e instanceof Error ? e.message : e);
  const at = raw.indexOf("{");
  if (at >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(at)) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* 不是 JSON，用原文 */
    }
  }
  return raw;
}

const dim = { color: "var(--text-dim)" } as const;
const danger = { color: "var(--danger)" } as const;

function when(ms?: number): string {
  return ms ? new Date(ms).toLocaleString("zh-CN") : "—";
}

function ScheduleCard({
  s,
  busy,
  onWrite,
  onError,
}: {
  s: ScheduleEntry;
  busy: boolean;
  onWrite: (fn: () => Promise<void>) => void;
  onError: (msg: string) => void;
}) {
  const toggle = () => {
    onWrite(async () => {
      try {
        const r = await api.setScheduleEnabled(s.id, !s.enabled);
        if (r.warnings.length > 0) onError(r.warnings.join("\n"));
      } catch (e) {
        onError(errText(e));
      }
    });
  };

  const del = () => {
    if (!confirm(`删除定时任务「${s.title}」(#${s.id})？此操作不可恢复。`)) return;
    onWrite(async () => {
      try {
        await api.deleteSchedule(s.id);
      } catch (e) {
        const msg = errText(e);
        if (String(e).includes("409") && confirm(`${msg}\n\n仍要强制删除吗？`)) {
          try {
            await api.deleteSchedule(s.id, true);
          } catch (e2) {
            onError(errText(e2));
          }
        } else onError(msg);
      }
    });
  };

  return (
    <div className="provider-card">
      <div className="pc-head">
        <span className="pc-name">{s.title}</span>
        <span className="pc-id">#{s.id}</span>
        {!s.enabled && <span className="state-badge cancelled">已停用</span>}
        {s.enabled && s.running && <span className="state-badge running">运行中</span>}
        {s.enabled && s.backoffActive && <span className="state-badge failed">退避中</span>}
        {s.enabled && s.failCount > 0 && !s.backoffActive && (
          <span className="state-badge waiting_user">
            连续失败 {s.failCount}，再 {s.failuresToAutoDisable} 次自动停用
          </span>
        )}
        {s.builtin && <span className="ovl-badge">内置</span>}
        {s.agentMissing && (
          <span className="ovl-badge" style={danger}>
            员工不存在
          </span>
        )}
        <span className="spacer" />
        <button disabled={busy} onClick={toggle}>
          {s.enabled ? "停用" : "启用"}
        </button>
        <button className="danger" disabled={busy} onClick={del}>
          删除
        </button>
      </div>

      <div className="pc-meta" style={dim}>
        {s.timingText} · {s.agentLabel}（{s.agentName}）· 跑 {s.runCount} / 跳过 {s.skipCount} / 连续失败{" "}
        {s.failCount} · 上次 {when(s.lastRunAt)}
        {s.backoffActive && ` · 退避至 ${when(s.backoffUntil)}`}
      </div>

      {/* 投递目标：这一页存在的理由，永不省略 */}
      <div className="pc-meta" style={dim}>
        投递 → {s.target.label} <span className="pc-id">{s.target.chatId}</span> · {s.target.channel}/
        {s.target.chatType === "group" ? "群" : "单聊"} · 归属 {s.ownerSenderName || "—"}
        <span className="pc-id"> {s.ownerSenderId}</span>
      </div>

      {s.target.issues.map((i) => (
        <div key={i.kind} style={{ ...danger, fontSize: 12, marginTop: 4 }}>
          ⚠️ {i.message}
        </div>
      ))}
      {!s.enabled && s.disabledReason && (
        <div style={{ color: "var(--warn)", fontSize: 12, marginTop: 4 }}>
          停用原因：{s.disabledReason}
        </div>
      )}
      {s.staleDisabledReason && (
        <div style={{ color: "var(--warn)", fontSize: 12, marginTop: 4 }}>
          已启用但残留停用原因「{s.disabledReason}」——点一次「启用」即可清掉
        </div>
      )}
      {s.dependsOn && (
        <div className="pc-meta" style={dim}>
          依赖 #{s.dependsOn}「{s.dependsOnLabel ?? "?"}」排序
          {s.dependsOnMissing && "（已不存在，按无依赖处理）"}
        </div>
      )}
      {s.dependents.length > 0 && (
        <div className="pc-meta" style={dim}>
          被依赖：{s.dependents.map((d) => `#${d.id}「${d.title}」`).join("、")}
        </div>
      )}
      <div className="pc-meta" style={{ ...dim, whiteSpace: "pre-wrap" }} title={s.prompt}>
        {s.prompt.length > 160 ? `${s.prompt.slice(0, 160)}…` : s.prompt}
      </div>
    </div>
  );
}

export function SchedulesPage() {
  const [data, setData] = useState<SchedulesResp>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      setData(await api.schedules());
      setErr(undefined);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  // 挂载拉一次 + 刷新按钮 + 写后重载。刻意不轮询：listChatMetas() 会把 chats/*.json
  // 全量 parse，而定时任务变化极慢，轮询是纯浪费 IO
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) {
    return (
      <div className="settings">
        <div className="settings-body">
          {err ? <div style={danger}>⚠️ {err}</div> : <div className="hint">加载中…</div>}
        </div>
      </div>
    );
  }

  const onWrite = (id: string) => (fn: () => Promise<void>) => {
    setBusy(id);
    void (async () => {
      try {
        await fn();
      } finally {
        setBusy(undefined);
        void load();
      }
    })();
  };

  return (
    <div className="settings">
      <div className="settings-body">
        <div className="settings-form" style={{ maxWidth: 960 }}>
          <div className="pc-head">
            <span className="pc-name">定时任务（全局）</span>
            <span className="pc-id">
              {data.stats.total}/{data.limits.total} 条 · 启用 {data.stats.enabled} · 停用{" "}
              {data.stats.disabled} · 运行中 {data.stats.running} · 投递异常 {data.stats.withIssues} ·{" "}
              {data.stats.chats} 个会话
            </span>
            <span className="spacer" />
            <button onClick={() => void load()}>刷新</button>
          </div>
          <div className="pc-meta" style={dim}>
            这里是跨所有会话的全量视图；主管在钉钉里只看得见「当前会话」的那部分。
          </div>
          {err && <div style={{ ...danger, whiteSpace: "pre-wrap" }}>⚠️ {err}</div>}
          {data.groups.length === 0 && <div className="empty">还没有定时任务</div>}
          {data.groups.map((g) => (
            <section key={g.chatId}>
              <h3>
                {g.label}
                <span className="pc-id" style={{ marginLeft: 8 }}>
                  {g.chatId}
                </span>
                <span className="pc-id" style={{ marginLeft: 8 }}>
                  {g.channel}/{g.chatType === "group" ? "群" : "单聊"} · {g.schedules.length} 条
                </span>
                {!g.known && (
                  <span className="ovl-badge" style={danger}>
                    会话无记录
                  </span>
                )}
                {g.issueKinds.includes("boss_blind") && (
                  <span className="ovl-badge" style={danger}>
                    主管看不见
                  </span>
                )}
                {g.issueKinds.includes("owner_multi_chat") && (
                  <span className="ovl-badge">同人多会话</span>
                )}
              </h3>
              <div className="provider-list">
                {g.schedules.map((s) => (
                  <ScheduleCard
                    key={s.id}
                    s={s}
                    busy={busy === s.id}
                    onWrite={onWrite(s.id)}
                    onError={setErr}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
