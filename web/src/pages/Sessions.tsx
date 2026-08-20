import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { api, subscribeTaskStream } from "../api";
import { Avatar, useAgentDirectory, type Face } from "../agent-face";
import type { BossDecision, ChatSummary, Squad, Task } from "../types";

export function SessionsPage() {
  const location = useLocation();
  // 深链支持：渠道消息里的「📊 详情」链接 /dashboard/sessions?chat=<chatId>&task=<taskId>
  const [searchParams] = useSearchParams();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedChat, setSelectedChat] = useState<string | undefined>(
    searchParams.get("chat") ??
      (location.state as { chatId?: string } | null)?.chatId ??
      undefined,
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | undefined>(
    searchParams.get("task") ?? undefined,
  );

  const refreshChats = useCallback(async () => {
    try {
      const { chats } = await api.chats("all");
      setChats(chats);
    } catch (e) {
      console.warn("refreshChats", e);
    }
  }, []);

  const refreshTasks = useCallback(async (chatId: string) => {
    try {
      const { tasks } = await api.chatTasks(chatId);
      setTasks(tasks);
    } catch (e) {
      console.warn("refreshTasks", e);
    }
  }, []);

  useEffect(() => {
    void refreshChats();
    const timer = setInterval(refreshChats, 5000);
    return () => clearInterval(timer);
  }, [refreshChats]);

  useEffect(() => {
    if (!selectedChat) return;
    void refreshTasks(selectedChat);
    const timer = setInterval(() => refreshTasks(selectedChat), 3000);
    return () => clearInterval(timer);
  }, [selectedChat, refreshTasks]);

  return (
    <div className="sessions-page">
      <ChatList
        chats={chats}
        selected={selectedChat}
        onSelect={(id) => {
          setSelectedChat(id);
          setSelectedTask(undefined);
        }}
      />
      <TaskColumn
        chatId={selectedChat}
        tasks={tasks}
        selectedTask={selectedTask}
        onSelect={setSelectedTask}
      />
      <StreamColumn taskId={selectedTask} task={tasks.find((t) => t.id === selectedTask)} />
    </div>
  );
}

function ChatList({
  chats,
  selected,
  onSelect,
}: {
  chats: ChatSummary[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const waiting = chats.filter((c) => c.waitingCount > 0);
  const rest = chats.filter((c) => c.waitingCount === 0);
  return (
    <div>
      {waiting.length > 0 && (
        <div style={{ padding: "10px 14px", background: "rgba(245,176,65,0.1)", color: "var(--warn)", fontSize: 12 }}>
          ⚠️ {waiting.length} 个会话有待用户确认
        </div>
      )}
      {[...waiting, ...rest].map((c) => (
        <div
          key={c.chatId}
          className={`chat-item ${c.chatId === selected ? "active" : ""}`}
          onClick={() => onSelect(c.chatId)}
        >
          <div className="row1">
            <span>{c.channel === "dingtalk" ? "💬" : c.channel === "cli" ? "🖥️" : "📡"}</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.chatId}
            </span>
            {c.activeCount > 0 && (
              <span className="state-badge running">活跃 {c.activeCount}</span>
            )}
            {c.waitingCount > 0 && (
              <span className="state-badge waiting_user">待确认 {c.waitingCount}</span>
            )}
          </div>
          <div className="senders">{c.senders.join(", ") || "-"}</div>
          <div className="time">{c.lastActivity ? new Date(c.lastActivity).toLocaleString() : "—"}</div>
        </div>
      ))}
      {chats.length === 0 && <div className="empty">还没有会话</div>}
    </div>
  );
}

function TaskColumn({
  chatId,
  tasks,
  selectedTask,
  onSelect,
}: {
  chatId?: string;
  tasks: Task[];
  selectedTask?: string;
  onSelect: (id: string) => void;
}) {
  const who = useAgentDirectory();
  if (!chatId) return <div className="empty">← 选一个会话</div>;
  if (tasks.length === 0) return <div className="empty">该会话还没有任务</div>;
  return (
    <div>
      {tasks.map((t) => {
        const id = who(t.agentName);
        return (
          <div
            key={t.id}
            className={`task-card compact ${t.id === selectedTask ? "selected" : ""}`}
            onClick={() => onSelect(t.id)}
          >
            <div className="task-title">{taskTitle(t)}</div>
            <div className="head">
              <Avatar face={id.face} size={20} />
              <span className="agent">{id.name}</span>
              {id.isTemp && <span className="badge-temp">临时</span>}
              <span className={`state-badge ${t.state}`}>{stateLabel(t.state)}</span>
              <span className="id">#{t.id}</span>
              <span className="time">{relTime(t.updatedAt)}</span>
            </div>
            <div className="prompt">{truncate(t.prompt.replace(/\s+/g, " ").trim(), 90)}</div>
            {t.state === "waiting_user" && t.question && (
              <div className="task-hint warn">❓ {truncate(t.question, 90)}</div>
            )}
            {t.error && <div className="task-hint danger">✗ {truncate(t.error, 90)}</div>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 任务标题：主管派工简报里的「目标」优先，否则取用户原话首句。
 * 派生规则与服务端 `server/boss/task-label.ts` 保持一致（只有长度不同：
 * 看板空间比 IM 大，这里给 48 字）。改一边记得同步另一边。
 */
export function taskTitle(t: Task): string {
  // 「套用：模板 A」这类是给组长的编队指令，不是任务名——兜底取首行时必须跳过
  const lines = (t.brief ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(套用|模板)[:：]/.test(l));
  const goal = lines
    .find((l) => /^目标[:：]/.test(l))
    ?.replace(/^目标[:：]\s*/, "");
  const raw = goal || lines[0] || t.prompt || "";
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const firstSentence = oneLine.split(/(?<=[。！？!?；;])/)[0] ?? oneLine;
  return truncate(firstSentence || oneLine, 48);
}

function stateLabel(s: string): string {
  return (
    { running: "运行", waiting_user: "待确认", queued: "排队", done: "完成", failed: "失败", cancelled: "已取消" }[
      s
    ] ?? s
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s前`;
  if (s < 3600) return `${Math.floor(s / 60)}m前`;
  if (s < 86400) return `${Math.floor(s / 3600)}h前`;
  return new Date(ts).toLocaleDateString();
}

// ═══════════════════════════════════════════════════════════════════════════
// 事件流：把碎片化事件归纳成"格子"（cells），文字连成一个 bubble
// ═══════════════════════════════════════════════════════════════════════════

type NormEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: unknown; isError?: boolean }
  | { kind: "progress"; id?: string; title?: string; status?: string; parentId?: string; employee?: string }
  | { kind: "state"; from?: string; to?: string }
  | { kind: "boundary"; label: string }
  | { kind: "boss"; decision: BossDecision }
  | { kind: "error"; message: string };

type Cell =
  | { k: "text"; id: number; text: string }
  | {
      k: "tool";
      id: number;
      toolId: string;
      name: string;
      input: unknown;
      result?: { content: unknown; isError?: boolean };
    }
  | { k: "progress"; id: number; steps: Array<{ id?: string; title?: string; status?: string; parentId?: string; employee?: string }> }
  | { k: "state"; id: number; from?: string; to?: string }
  | { k: "boundary"; id: number; label: string }
  | { k: "boss"; id: number; decision: BossDecision }
  | { k: "error"; id: number; message: string };

/** 从 trace log 事件归一化 */
function normalizeTrace(ev: any): NormEvent | undefined {
  if (!ev || typeof ev !== "object") return undefined;
  switch (ev.type) {
    case "text":
      return { kind: "text", text: String(ev.text ?? "") };
    case "thinking":
      // 思考不显示在主流（可以选择性展示）
      return undefined;
    case "tool_call":
      return { kind: "tool_call", id: String(ev.id ?? ""), name: String(ev.name ?? "?"), input: ev.input };
    case "tool_result":
      return {
        kind: "tool_result",
        toolUseId: String(ev.toolUseId ?? ""),
        content: ev.content,
        isError: ev.isError,
      };
    case "result":
      return undefined; // 顶部状态卡已经展示
    default:
      return undefined;
  }
}

/** 从事件总线（bus）事件归一化。ev 形如 { event, data } */
function normalizeAgentEvent(ev: any): NormEvent | undefined {
  if (!ev || typeof ev !== "object") return undefined;
  const t = ev.event as string | undefined;
  const d = ev.data ?? {};
  switch (t) {
    case "text":
      return { kind: "text", text: String(d.text ?? "") };
    case "tool_call":
      return { kind: "tool_call", id: String(d.id ?? ""), name: String(d.name ?? "?"), input: d.input };
    case "tool_result":
      return {
        kind: "tool_result",
        toolUseId: String(d.toolUseId ?? ""),
        content: d.content,
        isError: d.isError,
      };
    case "progress":
      return {
        kind: "progress",
        id: d.id,
        title: d.title,
        status: d.status,
        parentId: d.parentId,
        employee: d.employee,
      };
    case "result":
      return undefined;
    default:
      return undefined;
  }
}

/** 把归一化事件 append 到 cells：连续 text 合并；tool_result 找 tool_call 附着 */
function appendCell(cells: Cell[], ev: NormEvent, nextId: () => number): Cell[] {
  const next = [...cells];
  if (ev.kind === "text") {
    const last = next[next.length - 1];
    if (last && last.k === "text") {
      last.text += ev.text;
      return next;
    }
    next.push({ k: "text", id: nextId(), text: ev.text });
    return next;
  }
  if (ev.kind === "tool_call") {
    next.push({ k: "tool", id: nextId(), toolId: ev.id, name: ev.name, input: ev.input });
    return next;
  }
  if (ev.kind === "tool_result") {
    // 找最近未附结果的同 id 工具卡
    for (let i = next.length - 1; i >= 0; i--) {
      const c = next[i];
      if (c.k === "tool" && c.toolId === ev.toolUseId && !c.result) {
        c.result = { content: ev.content, isError: ev.isError };
        return next;
      }
    }
    // 找不到对应 tool_call，退化为独立提示行
    next.push({
      k: "tool",
      id: nextId(),
      toolId: ev.toolUseId,
      name: "(工具结果)",
      input: undefined,
      result: { content: ev.content, isError: ev.isError },
    });
    return next;
  }
  if (ev.kind === "progress") {
    // progress：按 id 合并到最近的 progress 组（同一 running 段），否则新建
    const step = { id: ev.id, title: ev.title, status: ev.status, parentId: ev.parentId, employee: ev.employee };
    const last = next[next.length - 1];
    if (last && last.k === "progress") {
      const idx = last.steps.findIndex((s) => s.id === ev.id && s.parentId === ev.parentId);
      if (idx === -1) last.steps.push(step);
      else last.steps[idx] = step;
      return next;
    }
    next.push({ k: "progress", id: nextId(), steps: [step] });
    return next;
  }
  if (ev.kind === "state") {
    next.push({ k: "state", id: nextId(), from: ev.from, to: ev.to });
    return next;
  }
  if (ev.kind === "boundary") {
    next.push({ k: "boundary", id: nextId(), label: ev.label });
    return next;
  }
  if (ev.kind === "boss") {
    next.push({ k: "boss", id: nextId(), decision: ev.decision });
    return next;
  }
  if (ev.kind === "error") {
    next.push({ k: "error", id: nextId(), message: ev.message });
    return next;
  }
  return next;
}

const MAX_CELLS = 300;

/** 编队流转面板：plan 步骤 → 执行者/评审人 → 状态 / 重做次数（3s 轮询后端 squad 状态） */
function SquadFlow({ taskId }: { taskId: string }) {
  const [squad, setSquad] = useState<Squad | null>(null);
  const [open, setOpen] = useState(true);
  const who = useAgentDirectory();

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const { squad: s } = await api.squad(taskId);
        if (alive) setSquad(s);
      } catch {
        if (alive) setSquad(null); // 编队已结束（状态文件被清理）
      }
    };
    void pull();
    const t = setInterval(pull, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [taskId]);

  if (!squad) return null;
  const byId = new Map(squad.outcomes.map((o) => [o.id, o]));
  const doneCount = squad.outcomes.filter((o) => o.status === "done").length;
  const total = squad.plan.steps.length;
  const currentIdx = squad.plan.steps.findIndex((st) => !byId.has(st.id));

  return (
    <div className="squad-flow">
      <div className="squad-head" onClick={() => setOpen((v) => !v)}>
        <span className="squad-icon">🤝</span>
        <span className="squad-title">编队流转</span>
        <span className="squad-progress">
          {doneCount}/{total} 步
        </span>
        <span className={`squad-phase ${squad.phase}`}>
          {squad.phase === "executing" ? "执行中" : "组长收尾"}
        </span>
        <span className="squad-toggle">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <>
          <div className="squad-goal">🎯 {squad.plan.goal}</div>
          {squad.plan.acceptance && (
            <div className="squad-accept">验收：{squad.plan.acceptance}</div>
          )}
          <div className="squad-steps">
            {squad.plan.steps.map((st, i) => {
              const o = byId.get(st.id);
              const state = o
                ? o.status === "done"
                  ? "done"
                  : "failed"
                : i === currentIdx && squad.phase === "executing"
                  ? "running"
                  : "pending";
              const retried = (o?.attempts ?? 1) > 1;
              return (
                <div key={st.id} className={`squad-step ${state}`}>
                  <div className="rail">
                    <span className="mark">
                      {state === "done"
                        ? "✓"
                        : state === "failed"
                          ? "✗"
                          : state === "running"
                            ? "⟳"
                            : i + 1}
                    </span>
                    {i < total - 1 && <span className="line" />}
                  </div>
                  <div className="body">
                    <div className="row1">
                      <span className="title">{st.title}</span>
                      <span className="who">
                        {st.employee === "temp" ? (
                          <>🧪 临时工 · {st.temp?.role ?? ""}</>
                        ) : (
                          <>
                            <Avatar face={who(st.employee).face} size={16} />
                            {who(st.employee).name}
                          </>
                        )}
                      </span>
                      {st.reviewer && (
                        <span className="reviewer">🔍 {who(st.reviewer).name}</span>
                      )}
                      {retried && <span className="retry">重做 ×{o!.attempts - 1}</span>}
                    </div>
                    {st.accept && <div className="accept">验收：{st.accept}</div>}
                    {o?.reviews?.length ? (
                      <div className="notes">
                        {o.reviews.map((r, k) => (
                          <div key={k} className="note">
                            {r.verdict === "pass"
                              ? "✅ 评审通过"
                              : r.verdict === "reject"
                                ? "❌ 评审未过"
                                : "⚠️ 评审无结论"}
                            （{who(r.reviewer).name}）{r.feedback ? `：${r.feedback}` : ""}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {o?.submitted === false && (
                      <div className="notes">
                        <div className="note">⚠️ 未按协议交卷，本步没有可信产出</div>
                      </div>
                    )}
                    {o?.retryNotes?.length ? (
                      <div className="notes">
                        {o.retryNotes.map((n, k) => (
                          <div key={k} className="note">
                            ↩︎ 第 {k + 1} 次重试：{n}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {o && (
                      <details className="outcome">
                        <summary>产出</summary>
                        <div>{o.conclusion}</div>
                      </details>
                    )}
                  </div>
                </div>
              );
            })}
            <div className={`squad-step ${squad.phase === "wrapup" ? "running" : "pending"}`}>
              <div className="rail">
                <span className="mark">🎖️</span>
              </div>
              <div className="body">
                <div className="row1">
                  <span className="title">组长收尾复核 + 交卷</span>
                  <span className="who">
                    <Avatar face={who("lead").face} size={16} />
                    {who("lead").name}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StreamColumn({ taskId, task }: { taskId?: string; task?: Task }) {
  const [cells, setCells] = useState<Cell[]>([]);
  const idRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const who = useAgentDirectory();

  useEffect(() => {
    setCells([]);
    idRef.current = 0;
    if (!taskId) return;

    const nextId = () => idRef.current++;
    const append = (ev: NormEvent | undefined) => {
      if (!ev) return;
      setCells((prev) => {
        const merged = appendCell(prev, ev, nextId);
        return merged.length > MAX_CELLS ? merged.slice(-MAX_CELLS) : merged;
      });
    };

    const close = subscribeTaskStream(taskId, {
      onTrace: (ev) => append(normalizeTrace(ev)),
      onAgentEvent: (ev) => append(normalizeAgentEvent(ev)),
      onStateChange: (ev) => {
        const e = ev as { from?: string; to?: string };
        append({ kind: "state", from: e.from, to: e.to });
      },
      onBossDecision: (d) => append({ kind: "boss", decision: d }),
      onReplayEnd: () => append({ kind: "boundary", label: "实时开始" }),
      onError: () => append({ kind: "error", message: "SSE 断线" }),
    });
    return close;
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [cells.length]);

  if (!taskId || !task) return <div className="empty">← 选一个任务看实时输出</div>;

  const id = who(task.agentName);

  return (
    <div className="stream-column">
      <div className="stream-head">
        <div className="stream-ident">
          <Avatar face={id.face} size={38} />
          <div className="stream-ident-text">
            <div className="stream-task-title">{taskTitle(task)}</div>
            <div className="stream-title">
              <strong>{id.name}</strong>
              {id.isTemp && <span className="badge-temp">临时</span>}
              <span className={`state-badge ${task.state}`}>{stateLabel(task.state)}</span>
              <span className="dim">#{task.id}</span>
              <span className="dim">· {task.channel}</span>
            </div>
          </div>
        </div>
        <div className="stream-sub">
          <span>{task.ownerSenderName || task.ownerSenderId}</span>
          <span> · 更新于 {relTime(task.updatedAt)}</span>
        </div>
        <details className="stream-prompt">
          <summary>原始 prompt</summary>
          <div>{task.prompt}</div>
        </details>
      </div>
      {task.agentName === "lead" && <SquadFlow taskId={task.id} />}
      <div className="stream-body">
        {cells.map((c) => (
          <CellView key={c.id} cell={c} face={id.face} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function CellView({ cell, face }: { cell: Cell; face: Face }) {
  if (cell.k === "text") {
    return (
      <div className="cell-text">
        <div className="cell-avatar">
          <Avatar face={face} size={26} />
        </div>
        <div className="cell-bubble">{cell.text}</div>
      </div>
    );
  }
  if (cell.k === "tool") {
    return <ToolCell cell={cell} />;
  }
  if (cell.k === "progress") {
    const done = cell.steps.filter((s) => !s.parentId && s.status === "done").length;
    const total = cell.steps.filter((s) => !s.parentId).length;
    return (
      <div className="cell-progress">
        <div className="progress-head">
          <span>流程执行</span>
          <span className="progress-count">
            {done}/{total}
          </span>
        </div>
        {cell.steps.map((s, i) => (
          <div key={`${s.id}-${i}`} className={`step ${s.status ?? ""} ${s.parentId ? "sub" : ""}`}>
            <span className="step-mark">
              {s.status === "done"
                ? "✓"
                : s.status === "failed"
                  ? "✗"
                  : s.status === "running"
                    ? "⟳"
                    : "○"}
            </span>
            <span className="step-title">{s.title ?? s.id}</span>
            {s.employee && <span className="step-who">{s.employee}</span>}
          </div>
        ))}
      </div>
    );
  }
  if (cell.k === "state") {
    return (
      <div className="cell-boundary state">
        <span className="hr" />
        <span className="label">状态：{cell.from} → {cell.to}</span>
        <span className="hr" />
      </div>
    );
  }
  if (cell.k === "boundary") {
    return (
      <div className="cell-boundary">
        <span className="hr" />
        <span className="label">── {cell.label} ──</span>
        <span className="hr" />
      </div>
    );
  }
  if (cell.k === "boss") {
    return <BossCell decision={cell.decision} />;
  }
  if (cell.k === "error") {
    return <div className="cell-error">✗ {cell.message}</div>;
  }
  return null;
}

const BOSS_KIND_LABEL: Record<BossDecision["kind"], string> = {
  intent: "对话决策",
  assist: "主管裁决",
  review: "验收",
  feedback: "反馈识别",
  route: "兜底路由",
};

/** 主管的一次判断：默认只显示结论摘要，展开才看模型原文与入参尾部 */
function BossCell({ decision }: { decision: BossDecision }) {
  return (
    <details className={`cell-boss ${decision.isError ? "err" : ""}`}>
      <summary>
        <span className="boss-badge">主管 · {BOSS_KIND_LABEL[decision.kind] ?? decision.kind}</span>
        <span className="boss-summary">{decision.summary}</span>
        <span className="dim">{decision.durationMs}ms</span>
      </summary>
      <pre className="boss-output">{decision.output || "（无输出）"}</pre>
      <details className="boss-prompt">
        <summary>入参（尾部）</summary>
        <pre>{decision.promptTail}</pre>
      </details>
    </details>
  );
}

function ToolCell({
  cell,
}: {
  cell: Extract<Cell, { k: "tool" }>;
}) {
  const [open, setOpen] = useState(false);
  const preview = summarize(cell.input, 80);
  const resultPreview =
    cell.result != null ? summarize(cell.result.content, 100) : undefined;
  return (
    <div className={`cell-tool ${cell.result?.isError ? "error" : ""}`}>
      <div className="cell-tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="mark">⚙</span>
        <span className="name">{cell.name}</span>
        <span className="args">{preview}</span>
        {resultPreview !== undefined && (
          <span className={`result-inline ${cell.result?.isError ? "err" : ""}`}>
            {cell.result?.isError ? "✗" : "↳"} {resultPreview}
          </span>
        )}
        <span className="toggle">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="cell-tool-detail">
          {cell.input !== undefined && (
            <>
              <div className="k">入参</div>
              <pre className="v">{formatJson(cell.input)}</pre>
            </>
          )}
          {cell.result && (
            <>
              <div className="k">{cell.result.isError ? "错误" : "结果"}</div>
              <pre className={`v ${cell.result.isError ? "err" : ""}`}>
                {typeof cell.result.content === "string"
                  ? cell.result.content
                  : formatJson(cell.result.content)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function summarize(v: unknown, max: number): string {
  if (v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function formatJson(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
