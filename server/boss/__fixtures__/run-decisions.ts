/**
 * 三路决策回归集跑测脚本。
 *
 * 只跑**决策层**：复用线上同一份 system prompt（buildSystemPrompt）与同一套工具定义
 * （buildBossTools 的 description / inputSchema 原样保留），但把 execute 换成桩——
 * 于是不会真派活、不烧员工 token，只断言「模型选了哪些工具」。
 *
 * 用法：npx tsx server/boss/__fixtures__/run-decisions.ts [caseId...]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config/index.js";
import { resolveProvider } from "../../config/provider-env.js";
import { getRuntime } from "../../runtime/index.js";
import { generateSessionId, saveSession } from "../../runtime/session-store.js";
import type { SessionMessage } from "../../runtime/session-store.js";
import { listRoutableAgents } from "../../agents/registry.js";
import { buildSystemPrompt } from "../boss-agent.js";
import { buildBossTools } from "../tools/boss-tools.js";
import type { Task, TaskState } from "../types.js";
import type { ChannelMessage } from "../../channels/types.js";

interface FixtureTask {
  taskId: string;
  agent: string;
  question?: string;
  prompt?: string;
  state?: string;
  result?: string;
  error?: string;
}

interface Fixture {
  id: string;
  desc: string;
  history: { role: "user" | "boss"; text: string }[];
  waiting: FixtureTask[];
  finished: FixtureTask[];
  message: string;
  expect: {
    action: string;
    allowed?: string[];
    taskId?: string;
    agent?: string;
    mustCall?: string[];
    mustNotCall?: string[];
    mustMention?: string[];
    note?: string;
  };
}

const here = dirname(fileURLToPath(import.meta.url));

function loadFixtures(): Fixture[] {
  return readFileSync(join(here, "decisions.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Fixture);
}

const CHAT_ID = "fixture:decisions";

function toTask(f: FixtureTask, state: TaskState): Task {
  const now = Date.now();
  return {
    id: f.taskId,
    channel: "cli",
    chatId: CHAT_ID,
    chatType: "private",
    ownerSenderId: "tester",
    ownerSenderName: "测试用户",
    agentName: f.agent,
    prompt: f.prompt ?? f.question ?? "",
    state,
    ...(f.question ? { question: f.question } : {}),
    ...(f.result ? { result: f.result } : {}),
    ...(f.error ? { error: f.error } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** 桩化：保留 description / inputSchema，只换 execute，避免真派活 */
function stubTools(
  real: Record<string, unknown>,
  called: { name: string; args: Record<string, unknown> }[],
  detail: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(real)) {
    const t = def as { execute?: unknown; [k: string]: unknown };
    out[name] = {
      ...t,
      execute: async (args: Record<string, unknown>) => {
        called.push({ name, args });
        if (name === "get_task_detail") {
          const id = String(args.taskId ?? "").replace(/^#/, "");
          return detail.get(id) ?? `没有找到任务 #${id}`;
        }
        if (name === "dispatch_task") {
          return `已建任务 #stub01 并派给「${args.agent ?? "系统选人"}」，现在开始执行。请把这件事告诉用户（带上任务号）。`;
        }
        if (name === "continue_task") return "已让他接着做，任务继续执行中。请告诉用户。";
        if (name === "answer_employee_question")
          return `已把你的答复转达给他，任务 #${args.taskId} 继续执行。`;
        if (name === "cancel_task") return `任务 #${args.taskId} 已取消。`;
        return "（测试桩）执行成功。";
      },
    };
  }
  return out;
}

async function runCase(f: Fixture): Promise<{ ok: boolean; reasons: string[]; log: string }> {
  const waiting = f.waiting.map((t) => toTask(t, "waiting_user"));
  const finished = f.finished.map((t) => toTask(t, (t.state as TaskState) ?? "done"));
  const detail = new Map<string, string>();
  for (const t of [...f.waiting, ...f.finished]) {
    detail.set(
      t.taskId,
      [
        `任务 #${t.taskId}（${t.agent}）：${t.prompt ?? t.question ?? ""}`,
        `状态：${t.state ?? "waiting_user"}`,
        t.question ? `待确认问题：${t.question}` : "",
        t.result ? `产出：${t.result}` : "",
        t.error ? `失败原因：${t.error}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // 会话历史：boss 侧写成 assistant，保持严格交替（连续同角色合并）
  const messages: SessionMessage[] = [];
  for (const h of f.history) {
    const role = h.role === "boss" ? "assistant" : "user";
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === "string") {
      last.content = `${last.content}\n\n${h.text}`;
    } else {
      messages.push({ role, content: h.text });
    }
  }
  const sessionId = generateSessionId();
  saveSession({
    id: sessionId,
    messages,
    activatedSkills: [],
    tokenEstimate: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });

  const msg: ChannelMessage = {
    channel: "cli",
    chatType: "private",
    chatId: CHAT_ID,
    senderId: "tester",
    senderName: "测试用户",
    text: f.message,
    raw: {},
  };
  const candidates = listRoutableAgents();
  const called: { name: string; args: Record<string, unknown> }[] = [];
  const realTools = buildBossTools({ msg, candidates, waiting, onAction: () => {} });
  const tools = stubTools(realTools, called, detail);

  const systemPrompt = buildSystemPrompt({
    waiting,
    active: waiting,
    finished,
    channel: "cli",
    chatType: "private",
    senderName: "测试用户",
  });

  const prov = resolveProvider({ id: config.boss.providerId, model: config.boss.model });
  const model =
    config.boss.model ?? config.routerModel ?? prov.providerDefaultModel ?? config.model;

  const runtime = getRuntime();
  const stream = await runtime.run({
    prompt: f.message,
    systemPrompt,
    ...(model ? { model } : {}),
    env: prov.env as Record<string, string>,
    resume: messages.length ? sessionId : undefined,
    persistSession: true,
    maxSteps: config.boss.maxSteps ?? 8,
    sdkOptions: { tools, systemPrompt },
  });

  let text = "";
  let isError = false;
  for await (const ev of stream) {
    if (ev.event === "text") text += String(ev.data.text ?? "");
    else if (ev.event === "result") {
      const r = ev.data as { result?: string; isError?: boolean };
      if (!text.trim() && r.result) text = r.result;
      if (r.isError) isError = true;
    }
  }

  const names = called.map((c) => c.name);
  const decision = names.filter((n) => n !== "get_task_detail" && n !== "list_tasks");
  const reasons: string[] = [];
  if (isError) reasons.push(`运行出错：${text.slice(0, 120)}`);

  const e = f.expect;
  const has = (n: string) => decision.includes(n);
  const argOf = (n: string) => called.find((c) => c.name === n)?.args;
  if (e.action === "answer_directly" && decision.length)
    reasons.push(`期望零动作直答，实际调了 ${decision.join(",")}`);
  if (e.action === "any_of" && e.allowed && !e.allowed.some((a) => a === "answer_directly" ? !decision.length : has(a)))
    reasons.push(`期望 ${e.allowed.join("|")}，实际 ${decision.join(",") || "直答"}`);
  if (["dispatch_task", "continue_task", "answer_employee_question", "cancel_task"].includes(e.action) && !has(e.action))
    reasons.push(`期望调 ${e.action}，实际 ${decision.join(",") || "直答"}`);
  for (const n of e.mustCall ?? []) if (!has(n)) reasons.push(`缺少必需工具 ${n}`);
  for (const n of e.mustNotCall ?? []) if (has(n)) reasons.push(`调了禁止的工具 ${n}`);
  for (const kw of e.mustMention ?? [])
    if (!text.includes(kw)) reasons.push(`回复未提到「${kw}」`);
  if (e.agent) {
    const actual = String(argOf("dispatch_task")?.agent ?? argOf("continue_task")?.agent ?? "");
    if (actual !== e.agent) reasons.push(`期望派给 ${e.agent}，实际 ${actual || "（未指定）"}`);
  }
  if (e.taskId) {
    const actual = String(argOf("answer_employee_question")?.taskId ?? "").replace(/^#/, "");
    if (actual !== e.taskId) reasons.push(`期望转达给 #${e.taskId}，实际 #${actual || "?"}`);
  }

  const argLog = called
    .map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 90)})`)
    .join(" ");
  return {
    ok: reasons.length === 0,
    reasons,
    log: `动作=[${decision.join(",") || "直答"}]\n    调用：${argLog || "无"}\n    回复：${text.replace(/\s+/g, " ").slice(0, 150)}`,
  };
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const all = loadFixtures();
  const cases = only.length ? all.filter((f) => only.includes(f.id)) : all;
  let pass = 0;
  const failed: string[] = [];

  for (const f of cases) {
    process.stdout.write(`\n▶ ${f.id}  「${f.message}」\n`);
    try {
      const r = await runCase(f);
      process.stdout.write(`    ${r.log}\n`);
      if (r.ok) {
        pass++;
        process.stdout.write(`    ✅ PASS\n`);
      } else {
        failed.push(f.id);
        process.stdout.write(`    ❌ FAIL：${r.reasons.join("；")}\n`);
      }
    } catch (err) {
      failed.push(f.id);
      process.stdout.write(`    ❌ ERROR：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  process.stdout.write(`\n━━━ ${pass}/${cases.length} 通过 ━━━\n`);
  if (failed.length) process.stdout.write(`未通过：${failed.join(", ")}\n`);
  process.exit(failed.length ? 1 : 0);
}

void main();
