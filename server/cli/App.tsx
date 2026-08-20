import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { ProgressData } from "../core/runner.js";
import { setupGuide } from "../core/onboarding.js";
import {
  postBossMessage,
  runAgentStream,
  subscribeBossEvents,
} from "./client.js";
import {
  listSessions,
  recordSession,
  saveLastSession,
  type SessionEntry,
} from "./session.js";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "toolout"; text: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface AgentInfo {
  name: string;
  description?: string;
}

export interface AppProps {
  baseUrl: string;
  agentName: string;
  /** boss=与主管对话（分诊派活），direct=直连指定 agent */
  mode: "boss" | "direct";
  /** boss 模式的会话标识（续接员工上下文用） */
  chatId: string;
  initialResume?: string;
  initialTaskId?: string;
  /** 显示用：local=内嵌 server，remote=远端地址 */
  backendLabel: string;
  /** server 端 playbook commands（补全数据源） */
  commands: CommandInfo[];
  /** server 端内置 agent 清单（/agents 数据源） */
  agents: AgentInfo[];
  /** 会话锚点变化回调（退出时打印恢复信息用） */
  onAnchorChange?: (anchor: { sessionId?: string; taskId?: string }) => void;
}

/** 会话锚点：普通 agent 只有 sessionId；workflow agent 先有 taskId、首次追问后补 sessionId */
interface SessionAnchor {
  sessionId?: string;
  taskId?: string;
}

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "setup", description: "配置指引：模型凭据 / 钉钉渠道 / 看板地址" },
  { name: "agents", description: "列出内置 agent" },
  { name: "new", description: "重开会话" },
  { name: "resume", description: "列出/恢复历史会话", argumentHint: "[编号]" },
  { name: "cost", description: "本次 CLI 会话累计消耗" },
  { name: "help", description: "显示可用命令" },
  { name: "exit", description: "退出" },
];

let itemSeq = 0;
const keyed = (item: Item) => ({ ...item, key: `i${itemSeq++}` });

function summarize(value: unknown, max = 120): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return "";
  }
}

const STEP_ICON: Record<ProgressData["status"], { char: string; color: string }> = {
  pending: { char: "○", color: "gray" },
  running: { char: "", color: "magenta" }, // running 用 Spinner 渲染
  done: { char: "✓", color: "green" },
  failed: { char: "✗", color: "red" },
};

function StepLine({ step, indent }: { step: ProgressData; indent: boolean }) {
  const icon = STEP_ICON[step.status];
  return (
    <Box marginLeft={indent ? 3 : 0}>
      {step.status === "running" ? (
        <Text color="magenta">
          <Spinner type="dots" />
        </Text>
      ) : (
        <Text color={icon.color}>{icon.char}</Text>
      )}
      <Text color={step.status === "pending" ? "gray" : undefined}> {step.title}</Text>
      {step.employee && <Text color="gray"> · {step.employee}</Text>}
    </Box>
  );
}

interface Cost {
  inTok: number;
  outTok: number;
  cacheRead: number;
  cacheCreate: number;
  turns: number;
  ms: number;
  runs: number;
}

export function App({
  baseUrl,
  agentName,
  mode,
  chatId,
  initialResume,
  initialTaskId,
  backendLabel,
  commands,
  agents,
  onAnchorChange,
}: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<Array<Item & { key: string }>>([
    keyed({
      kind: "info",
      text: `${mode === "boss" ? "与主管 boss 对话（自动分诊派活）" : `agent: ${agentName}`} · backend: ${backendLabel}${initialResume || initialTaskId ? " · 已恢复上次会话" : ""}\n输入内容开始对话；/agents 查看团队成员，/help 查看命令，Esc 中断当前轮，Ctrl+O 切换工具输出`,
    }),
  ]);
  const [streamText, setStreamText] = useState("");
  const [busy, setBusy] = useState(false);
  /** 当前正在执行的工具名（tool_call 后、下一段文本前） */
  const [activity, setActivity] = useState<string | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  /** workflow 进度树（progress 事件驱动，回合结束清空） */
  const [steps, setSteps] = useState<ProgressData[]>([]);
  const [input, setInput] = useState("");
  const [queue, setQueue] = useState<string[]>([]);
  const [verbose, setVerbose] = useState(false);
  const sessionRef = useRef<SessionAnchor>({
    sessionId: initialResume,
    taskId: initialTaskId,
  });
  const abortRef = useRef<AbortController | undefined>(undefined);
  const lastInputRef = useRef("");
  const firstPromptRef = useRef<string | undefined>(undefined);
  const resumeListRef = useRef<SessionEntry[]>([]);
  const verboseRef = useRef(false);
  const costRef = useRef<Cost>({
    inTok: 0,
    outTok: 0,
    cacheRead: 0,
    cacheCreate: 0,
    turns: 0,
    ms: 0,
    runs: 0,
  });

  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [busy]);

  const push = (...items: Item[]) =>
    setHistory((prev) => [...prev, ...items.map(keyed)]);

  const allCommands = [...BUILTIN_COMMANDS, ...commands];
  const suggestions =
    input.startsWith("/") && !input.includes(" ")
      ? allCommands
          .filter((c) => c.name.startsWith(input.slice(1)))
          .slice(0, 6)
      : [];
  const [selIdx, setSelIdx] = useState(0);
  // 输入变化后建议列表可能缩短，钳制选中位
  const sel = suggestions.length > 0 ? Math.min(selIdx, suggestions.length - 1) : 0;

  const applySuggestion = () => {
    setInput(`/${suggestions[sel].name} `);
    setSelIdx(0);
  };

  useInput((ch, key) => {
    if (key.escape) {
      if (abortRef.current) abortRef.current.abort();
      else if (lastInputRef.current && !input) setInput(lastInputRef.current);
      return;
    }
    if (key.ctrl && ch === "o") {
      setVerbose((v) => {
        verboseRef.current = !v;
        return !v;
      });
      return;
    }
    if (suggestions.length > 0) {
      if (key.upArrow) {
        setSelIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.downArrow) {
        setSelIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (key.tab) {
        applySuggestion();
      }
    }
  });

  /** 内建命令；返回 true 表示已处理 */
  const handleBuiltin = (prompt: string): boolean => {
    const [cmd, ...rest] = prompt.slice(1).split(/\s+/);
    switch (cmd) {
      case "exit":
      case "quit":
        exit();
        return true;
      case "setup":
        push({
          kind: "info",
          text: setupGuide(
            Number(new URL(baseUrl).port) || undefined,
            !backendLabel.startsWith("local"),
          ),
        });
        return true;
      case "agents":
        push({
          kind: "info",
          text:
            agents.length === 0
              ? "无法获取 agent 清单"
              : `内置 agent（启动参数 --agent=<name> 切换）：\n${agents
                  .map(
                    (a) =>
                      `${a.name === agentName ? "❯ " : "  "}${a.name} — ${a.description ?? ""}`,
                  )
                  .join("\n")}`,
        });
        return true;
      case "new":
        sessionRef.current = {};
        firstPromptRef.current = undefined;
        onAnchorChange?.({});
        push({ kind: "info", text: "已重开会话" });
        return true;
      case "help":
        push({
          kind: "info",
          text: allCommands
            .map(
              (c) =>
                `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""} — ${c.description ?? ""}`,
            )
            .join("\n"),
        });
        return true;
      case "cost": {
        const c = costRef.current;
        push({
          kind: "info",
          text: `本次 CLI 会话累计：${c.runs} 次运行 · ${c.turns} turns · ${(c.ms / 1000).toFixed(1)}s\ntokens: in ${c.inTok} · out ${c.outTok} · cache read ${c.cacheRead} · cache write ${c.cacheCreate}`,
        });
        return true;
      }
      case "resume": {
        const n = Number(rest[0]);
        if (rest[0] && Number.isInteger(n)) {
          const picked = resumeListRef.current[n - 1];
          if (!picked) {
            push({ kind: "error", text: `无效编号：${rest[0]}（先执行 /resume 查看列表）` });
          } else {
            sessionRef.current = {
              sessionId: picked.sessionId,
              taskId: picked.taskId,
            };
            onAnchorChange?.(sessionRef.current);
            push({ kind: "info", text: `已恢复会话：${picked.firstPrompt}` });
          }
          return true;
        }
        const sessions = listSessions(agentName).slice(-8).reverse();
        resumeListRef.current = sessions;
        push({
          kind: "info",
          text:
            sessions.length === 0
              ? "没有历史会话"
              : `历史会话（/resume <编号> 恢复）：\n${sessions
                  .map(
                    (s, i) =>
                      `${i + 1}. [${s.time.slice(5, 16).replace("T", " ")}] ${summarize(s.firstPrompt, 40)}`,
                  )
                  .join("\n")}`,
        });
        return true;
      }
      default:
        return false; // 非内建：透传 server（playbook command 由 SDK 解析）
    }
  };

  const submit = async (value: string) => {
    const prompt = value.trim();
    if (!prompt) return;
    setInput("");
    lastInputRef.current = prompt;

    // 内建命令即时处理（busy 时 /exit 也立即生效）
    if (prompt.startsWith("/") && !busy && handleBuiltin(prompt)) return;
    if (prompt === "/exit" || prompt === "/quit") {
      exit();
      return;
    }

    if (busy) {
      setQueue((q) => [...q, prompt]);
      push({ kind: "info", text: `⏸ 已排队：${summarize(prompt, 60)}` });
      return;
    }

    push({ kind: "user", text: prompt });
    setBusy(true);
    setStreamText("");
    setActivity(undefined);
    setSteps([]);
    if (!sessionRef.current.sessionId && !sessionRef.current.taskId) {
      firstPromptRef.current = prompt;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    // Static 的 item 只增不改，流式文本先积在 streamText，遇到工具调用/结束再落盘
    let pending = "";
    let stepStats: { done: number; total: number } | undefined;
    const flushText = () => {
      if (pending.trim()) push({ kind: "assistant", text: pending });
      pending = "";
      setStreamText("");
    };

    try {
      // boss 模式：消息投递即返回，boss 回复经常驻订阅流回（可能在数分钟后）
      if (mode === "boss") {
        await postBossMessage(
          baseUrl,
          { prompt, chatId, senderName: "本地用户" },
          abort.signal,
        );
        setActivity("boss 处理中");
        return;
      }

      const anchor = sessionRef.current;
      const events = runAgentStream(
        baseUrl,
        agentName,
        {
          prompt,
          resume: anchor.sessionId,
          ...(anchor.taskId ? { params: { taskId: anchor.taskId } } : {}),
        },
        abort.signal,
      );
      for await (const e of events) {
        if (e.event === "text") {
          setActivity(undefined);
          pending += e.data.text as string;
          setStreamText(pending);
        } else if (e.event === "agent") {
          // boss 分诊结果：标明经手员工
          push({
            kind: "info",
            text: `→ 交给「${String(e.data.name)}」${e.data.resumed ? "（接着上次上下文）" : ""}`,
          });
        } else if (e.event === "tool_call") {
          flushText();
          setActivity(String(e.data.name));
          push({
            kind: "tool",
            name: String(e.data.name),
            summary: summarize(e.data.input),
          });
        } else if (e.event === "tool_result") {
          setActivity(undefined);
          if (verboseRef.current) {
            push({ kind: "toolout", text: summarize(e.data.content, 200) });
          }
        } else if (e.event === "progress") {
          const p = e.data as unknown as ProgressData;
          setSteps((prev) => {
            const idx = prev.findIndex(
              (s) => s.id === p.id && s.parentId === p.parentId,
            );
            if (idx === -1) return [...prev, p];
            const next = [...prev];
            next[idx] = p;
            stepStats = {
              done: next.filter((s) => s.status === "done").length,
              total: next.length,
            };
            return next;
          });
        } else if (e.event === "result") {
          const sessionId = e.data.sessionId as string | undefined;
          const taskId = e.data.taskId as string | undefined;
          if (mode === "direct") {
            if (sessionId) sessionRef.current.sessionId = sessionId;
            if (taskId) sessionRef.current.taskId = taskId;
            if (sessionId || taskId) {
              onAnchorChange?.(sessionRef.current);
              saveLastSession({ ...sessionRef.current, agent: agentName });
              recordSession({
                ...sessionRef.current,
                agent: agentName,
                firstPrompt: firstPromptRef.current ?? prompt,
              });
            }
          }
          // 累计消耗
          const u = (e.data.usage ?? {}) as Record<string, number>;
          const c = costRef.current;
          c.inTok += u.input_tokens ?? 0;
          c.outTok += u.output_tokens ?? 0;
          c.cacheRead += u.cache_read_input_tokens ?? 0;
          c.cacheCreate += u.cache_creation_input_tokens ?? 0;
          c.turns += Number(e.data.numTurns ?? 0);
          c.ms += Number(e.data.durationMs ?? 0);
          c.runs += 1;

          flushText();
          const turns = e.data.numTurns ?? "?";
          const secs = e.data.durationMs
            ? `${(Number(e.data.durationMs) / 1000).toFixed(1)}s`
            : "";
          const stepNote = stepStats
            ? ` · ${stepStats.done}/${stepStats.total} 步骤完成`
            : "";
          const tokNote = u.output_tokens ? ` · ↓${u.output_tokens}tok` : "";
          push({
            kind: "info",
            text: `— ${turns} turns ${secs}${stepNote}${tokNote}`,
          });
        } else if (e.event === "error") {
          flushText();
          push({ kind: "error", text: String(e.data.message ?? "unknown error") });
        }
      }
      flushText();
    } catch (error) {
      flushText();
      if (abort.signal.aborted) {
        push({ kind: "info", text: "已中断" });
      } else {
        push({
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        });
      }
      // 投递/执行失败：boss 模式也要解除等待态（不会再有推送回来）
      if (mode === "boss") {
        setActivity(undefined);
        setBusy(false);
      }
    } finally {
      abortRef.current = undefined;
      setSteps([]);
      // boss 模式：投递成功后仍处于等待态（回复由推送流带回时再解除 busy 与 activity）
      if (mode !== "boss") {
        setActivity(undefined);
        setBusy(false);
      }
    }
  };

  // boss 渠道常驻订阅：boss 的全部出站消息（ack / 进度播报 / 待确认问题 / 验收汇报）
  // 由服务端推送而来——与钉钉同构。后台任务完成时也能收到，不受某轮请求生命周期限制。
  useEffect(() => {
    if (mode !== "boss") return;
    const abort = new AbortController();
    let stopped = false;
    void (async () => {
      while (!stopped) {
        try {
          for await (const e of subscribeBossEvents(baseUrl, chatId, abort.signal)) {
            if (e.event === "boss_message") {
              push({ kind: "assistant", text: String(e.data.text) });
              setActivity(undefined);
              setBusy(false);
            }
          }
        } catch {
          if (stopped) return;
        }
        // 断线重连（服务重启 / 网络抖动）
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    return () => {
      stopped = true;
      abort.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, baseUrl, chatId]);

  // 排队消息：当前轮结束后逐条出队
  useEffect(() => {
    if (busy || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void submit(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue]);

  const topSteps = steps.filter((s) => !s.parentId);

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(item) => (
          <Box
            key={item.key}
            marginBottom={item.kind === "tool" || item.kind === "toolout" ? 0 : 1}
          >
            {item.kind === "user" && (
              <Text>
                <Text color="cyan" bold>
                  {"> "}
                </Text>
                {item.text}
              </Text>
            )}
            {item.kind === "assistant" && <Text>{item.text}</Text>}
            {item.kind === "tool" && (
              <Text color="gray">
                {"  ⚙ "}
                {item.name}({item.summary})
              </Text>
            )}
            {item.kind === "toolout" && (
              <Text color="gray" dimColor>
                {"    ↳ "}
                {item.text}
              </Text>
            )}
            {item.kind === "info" && <Text color="gray">{item.text}</Text>}
            {item.kind === "error" && <Text color="red">✗ {item.text}</Text>}
          </Box>
        )}
      </Static>

      {busy && (
        <Box flexDirection="column">
          {streamText ? <Text>{streamText}</Text> : null}

          {topSteps.length > 0 && (
            <Box flexDirection="column" marginTop={streamText ? 1 : 0}>
              {topSteps.map((s) => (
                <Box key={s.id} flexDirection="column">
                  <StepLine step={s} indent={false} />
                  {/* 渐进披露：仅展开 running 父步骤的子步骤 */}
                  {s.status === "running" &&
                    steps
                      .filter((c) => c.parentId === s.id)
                      .map((c) => <StepLine key={c.id} step={c} indent />)}
                </Box>
              ))}
            </Box>
          )}

          <Box marginTop={streamText || topSteps.length > 0 ? 1 : 0}>
            <Text color="magenta">
              <Spinner type="dots" />
            </Text>
            <Text color="gray">
              {" "}
              {activity ? `${activity} 运行中` : "thinking"}…
              {elapsed > 0 ? ` ${elapsed}s` : ""} · Esc 中断
              {queue.length > 0 ? ` · ${queue.length} 条排队中` : ""}
            </Text>
          </Box>
        </Box>
      )}

      <Box>
        <Text color={busy ? "gray" : "cyan"} bold>
          {"> "}
        </Text>
        <TextInput
          value={input}
          onChange={(v) => {
            setInput(v);
            setSelIdx(0);
          }}
          onSubmit={(v) => {
            // 建议列表可见且未输全：Enter = 选中补全，不提交
            if (
              suggestions.length > 0 &&
              v.trim() !== `/${suggestions[sel].name}`
            ) {
              applySuggestion();
              return;
            }
            void submit(v);
          }}
          placeholder={busy ? "运行中，回车排队…" : undefined}
        />
      </Box>

      {suggestions.length > 0 && (
        <Box flexDirection="column">
          {suggestions.map((c, i) => (
            <Text
              key={c.name}
              color={i === sel ? "cyan" : "gray"}
              bold={i === sel}
            >
              {i === sel ? " ❯ /" : "   /"}
              {c.name}
              {c.argumentHint ? ` ${c.argumentHint}` : ""} — {c.description ?? ""}
            </Text>
          ))}
          <Text color="gray" dimColor>
            {"   ↑↓ 选择 · Tab/Enter 补全"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
