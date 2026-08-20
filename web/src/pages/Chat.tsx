import { useEffect, useMemo, useRef, useState } from "react";
import { api, postBossMessage, subscribeBossEvents } from "../api";
import type { ChatMessage, ChatSummary } from "../types";

/** 后台发言时用的发送者名：与历史记录里的 senderName 一致，用于识别「自己发的」 */
const SELF_SENDER = "后台用户";

/** 后台自己的本地会话：列表里始终存在，即使还没说过话 */
const LOCAL_CHAT: ChatSummary = {
  chatId: "web:local",
  channel: "cli",
  chatType: "private",
  title: "后台本地会话",
  taskCount: 0,
  activeCount: 0,
  waitingCount: 0,
  senders: [],
  lastActivity: 0,
};

type Bubble = ChatMessage & { key: number };

export function ChatPage() {
  const [chats, setChats] = useState<ChatSummary[]>([LOCAL_CHAT]);
  const [activeId, setActiveId] = useState(LOCAL_CHAT.chatId);
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [bossName, setBossName] = useState("主管");
  const [filter, setFilter] = useState("");
  const seqRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const active = chats.find((c) => c.chatId === activeId) ?? LOCAL_CHAT;
  const isDingtalk = active.channel === "dingtalk";

  const push = (m: ChatMessage) =>
    setMessages((prev) => [...prev, { ...m, key: seqRef.current++ }]);

  useEffect(() => {
    api
      .team()
      .then((g) => {
        const boss = g.nodes.find((n) => n.id === "__boss__");
        if (boss?.name) setBossName(boss.name);
      })
      .catch(() => {});
  }, []);

  /** 会话列表：轮询刷新，让钉钉那边的新会话/新消息自动冒出来 */
  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .chats()
        .then((r) => {
          if (!alive) return;
          const list = r.chats.map((c) =>
            // 本地会话一旦有真实消息，服务端记录里没有 title，标题会退回成裸 chatId
            c.chatId === LOCAL_CHAT.chatId && !c.title ? { ...c, title: LOCAL_CHAT.title } : c,
          );
          if (!list.some((c) => c.chatId === LOCAL_CHAT.chatId)) list.push(LOCAL_CHAT);
          setChats(list);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  /** 切换会话：加载历史 */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setMessages([]);
    seqRef.current = 0;
    api
      .chatMessages(activeId)
      .then((r) => {
        if (!alive) return;
        setMessages(r.messages.map((m) => ({ ...m, key: seqRef.current++ })));
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeId]);

  /**
   * 常驻订阅当前会话的 boss 出站消息。
   * 这条流也承载后台任务几小时后的验收汇报，以及钉钉那边其他人触发的对话。
   */
  useEffect(() => {
    const close = subscribeBossEvents(activeId, (text) => {
      push({ at: Date.now(), direction: "out", text });
      setSending(false);
    });
    return close;
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submit = () => {
    const prompt = input.trim();
    if (!prompt || sending) return;
    setInput("");
    push({ at: Date.now(), direction: "in", senderName: SELF_SENDER, text: prompt });
    setSending(true);
    void postBossMessage({ prompt, chatId: activeId, senderName: SELF_SENDER })
      .catch((e: unknown) => {
        push({
          at: Date.now(),
          direction: "out",
          text: `发送失败：${e instanceof Error ? e.message : String(e)}`,
          error: "send-failed",
        });
        setSending(false);
      })
      .finally(() => setTimeout(() => inputRef.current?.focus(), 50));
  };

  const rename = async () => {
    const next = window.prompt("给这个会话起个名字", active.title ?? "");
    if (!next?.trim()) return;
    try {
      await api.setChatTitle(activeId, next.trim());
      setChats((prev) =>
        prev.map((c) => (c.chatId === activeId ? { ...c, title: next.trim() } : c)),
      );
    } catch {
      /* 会话还没有任何消息时后端会 404，忽略 */
    }
  };

  const visible = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    if (!kw) return chats;
    return chats.filter((c) =>
      [c.title, c.chatId, c.lastText, ...c.senders]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(kw)),
    );
  }, [chats, filter]);

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜会话…"
          />
        </div>
        <div className="chat-list">
          {visible.map((c) => (
            <button
              key={c.chatId}
              className={`chat-item ${c.chatId === activeId ? "active" : ""}`}
              onClick={() => setActiveId(c.chatId)}
            >
              <div className="chat-item-top">
                <span className="chat-item-name">{chatLabel(c)}</span>
                {c.activeCount > 0 && <span className="chat-badge">{c.activeCount}</span>}
              </div>
              <div className="chat-item-sub">
                <span className={`chan-tag ${c.channel ?? "cli"}`}>{channelLabel(c)}</span>
                {c.lastText && <span className="chat-item-preview">{oneLine(c.lastText)}</span>}
              </div>
            </button>
          ))}
          {visible.length === 0 && <div className="empty">没有匹配的会话</div>}
        </div>
      </aside>

      <div className="chat-main">
        <div className="chat-toolbar">
          <span className="chat-title">{chatLabel(active)}</span>
          <span className={`chan-tag ${active.channel ?? "cli"}`}>{channelLabel(active)}</span>
          <span className="chat-hint">
            <code>{abbrevId(active.chatId)}</code>
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={rename}>重命名</button>
        </div>

        {isDingtalk && (
          <div className="chat-warn">
            ⚠️ 这是钉钉会话。你在这里发言，{bossName}的回复会
            <strong>真的发到钉钉{active.chatType === "group" ? "群里" : "单聊里"}</strong>
            {active.chatType === "group" ? "，群成员都能看到。" : "。"}
          </div>
        )}

        <div className="chat-messages">
          {loading && <div className="empty">加载历史…</div>}
          {!loading && messages.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty-hero">👋</div>
              <div>你好，我是{bossName}。</div>
              <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 12 }}>
                直接说需求，我会分诊派给对应的同事；社交话题我自己答。
              </div>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.key} msg={m} />
          ))}
          {sending && (
            <div className="msg assistant">
              <div className="avatar">👑</div>
              <div className="bubble">
                <TypingDots />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="chat-composer">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 输入法组合输入中（选词）的回车不能当发送——那是在确认候选词。
              // e.key 此时仍是 "Enter"，只有 isComposing / keyCode 229 能区分。
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              isDingtalk
                ? "发言会同步到钉钉…（Enter 发送，Shift+Enter 换行）"
                : "说点什么…（Enter 发送，Shift+Enter 换行）"
            }
            rows={3}
          />
          <div className="chat-actions">
            <button className="primary" onClick={submit} disabled={!input.trim()}>
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Bubble }) {
  if (msg.direction === "in") {
    // 只有别人（钉钉那边的成员）发的才标名字，自己发的不必重复
    const showWho = msg.senderName && msg.senderName !== SELF_SENDER;
    return (
      <div className="msg user">
        <div style={{ maxWidth: "80%" }}>
          {showWho && (
            <div className="assistant-who" style={{ textAlign: "right" }}>
              {msg.senderName}
            </div>
          )}
          <div className="bubble">{msg.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg assistant">
      <div className="avatar">👑</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className={`bubble ${msg.error ? "err" : ""}`}>{msg.text || "（无输出）"}</div>
        {msg.card && <div className="chat-card-hint">按钮：{msg.card}</div>}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="typing">
      <span></span>
      <span></span>
      <span></span>
    </span>
  );
}

/**
 * 会话显示名。自定义标题优先；其次分渠道取值：
 * - 钉钉的 chatId 是无意义长串（openConversationId / staffId），用发言人名更可读
 * - CLI/本地的 chatId 本身就有语义（cli:perm-check、incident），直接用它
 *   （早先一律用发言人名，结果列表里七个「本地用户」完全分不清）
 */
function chatLabel(c: ChatSummary): string {
  if (c.title) return c.title;
  if (c.channel === "dingtalk" && c.senders.length > 0) return c.senders.join("、");
  return abbrevId(c.chatId);
}

function channelLabel(c: ChatSummary): string {
  if (c.channel === "dingtalk") return c.chatType === "group" ? "钉钉群" : "钉钉单聊";
  return "本地";
}

/** 钉钉 chatId 又长又无意义，只留头尾便于辨识 */
function abbrevId(id: string): string {
  return id.length > 22 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id;
}

function oneLine(s: string, max = 40): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
