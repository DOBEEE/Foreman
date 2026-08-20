import { taskManager as tm } from "./task-manager.js";
import { employeeDisplayName } from "./persona.js";
import { listTempProfiles } from "./temp-worker.js";
import { inboxDepth } from "./inbox.js";
import { budgetStatus } from "./budget.js";
import { listTopicIndex, renderTopicIndex, type TopicIndexEntry } from "./thinking-store.js";
import type { Task } from "./types.js";

/**
 * 分层态势快照。
 *
 * 取代 boss-agent.ts buildSystemPrompt 里散装的 activeBlock / finishedBlock，
 * 供所有唤醒事件共用。
 *
 * 设计原则：
 * - 常驻核心（~800 chars）：计数 + 每在跑任务一行
 * - 事件聚焦（由 trigger-frame 补充）：触发事件全文
 * - 深挖按需：boss 用 get_task_detail 取其余任务原文
 * - 硬上限 4000 chars：超出按优先级裁剪
 */

const SITUATION_CHAR_BUDGET = 4000;

// ─── Types ────────────────────────────────────────────────────

export interface TaskSummary {
  id: string;
  state: string;
  agentDisplay: string;
  agentName: string;
  promptSnippet: string;
  question?: string;
  error?: string;
}

export interface TempWorkerSummary {
  id: string;
  display: string;
  capability: string;
  taskId: string;
}

export interface Situation {
  activeTasks: TaskSummary[];
  recentFinished: TaskSummary[];
  queuedCount: number;
  waitingCount: number;
  runningCount: number;
  tempWorkers: TempWorkerSummary[];
  pendingInbox: number;
  budget: { turnsUsed: number; turnsMax: number; cooling: boolean };
  /** 脑爆话题索引（仅索引行常驻；全文由 read_thinking 按需拉） */
  thinkingTopics: TopicIndexEntry[];
}

// ─── Public API ───────────────────────────────────────────────

export function buildSituation(chatId: string): Situation {
  const active = tm.activeTasks(chatId);
  const finished = tm.recentFinishedTasks(chatId, 5);
  const temps = listTempProfiles();

  return {
    activeTasks: active.map(summarizeTask),
    recentFinished: finished.map(summarizeTask),
    queuedCount: active.filter((t) => t.state === "queued").length,
    waitingCount: active.filter((t) => t.state === "waiting_user").length,
    runningCount: active.filter((t) => t.state === "running").length,
    tempWorkers: temps
      .filter((p) => p.temp?.chatId === chatId)
      .map((p) => ({
        id: p.id,
        display: p.displayName ?? p.id,
        capability: p.temp!.capability,
        taskId: p.temp!.taskId,
      })),
    pendingInbox: inboxDepth(chatId),
    budget: (() => {
      const b = budgetStatus(chatId);
      return { turnsUsed: b.turnsUsed, turnsMax: b.turnsMax, cooling: b.cooling };
    })(),
    thinkingTopics: listTopicIndex(chatId),
  };
}

export function renderSituation(situation: Situation): string {
  const parts: string[] = [];

  // 概览行
  parts.push(
    `进行中 ${situation.runningCount} | 排队 ${situation.queuedCount} | 等用户 ${situation.waitingCount} | 临时工 ${situation.tempWorkers.length}`,
  );
  if (situation.budget.cooling) {
    parts.push("⚠️ 系统轮次预算冷却中（当前用降级路径处理系统事件）");
  }

  // 活跃任务
  if (situation.activeTasks.length > 0) {
    parts.push("");
    parts.push("### 活跃任务");
    for (const t of situation.activeTasks) {
      let line = `#${t.id} [${t.state}] ${t.agentDisplay}(${t.agentName})：${t.promptSnippet}`;
      if (t.question) line += ` ← 等回答：${t.question.slice(0, 40)}`;
      parts.push(line);
    }
  }

  // 最近收尾
  if (situation.recentFinished.length > 0) {
    parts.push("");
    parts.push("### 最近收尾（要原文调 get_task_detail）");
    for (const t of situation.recentFinished) {
      let line = `#${t.id} [${t.state === "done" ? "完成" : "失败"}] ${t.agentDisplay}：${t.promptSnippet}`;
      if (t.error) line += ` ← 错误：${t.error.slice(0, 50)}`;
      parts.push(line);
    }
  }

  // 临时工
  if (situation.tempWorkers.length > 0) {
    parts.push("");
    parts.push("### 在岗临时工");
    for (const tw of situation.tempWorkers) {
      parts.push(`- ${tw.display}（${tw.id}）：${tw.capability}，绑定 #${tw.taskId}`);
    }
  }

  // 脑爆话题索引：**只给索引行**，全文由 read_thinking 按需拉。
  // 全量常驻会在聊过十个话题后把注意力挤爆（同类事故：复盘任务占满快照后 boss 答非所问）
  if (situation.thinkingTopics.length > 0) {
    parts.push("");
    parts.push("### 聊过的话题（要看细节调 read_thinking）");
    parts.push(renderTopicIndex(situation.thinkingTopics));
  }

  let text = parts.join("\n");
  if (text.length > SITUATION_CHAR_BUDGET) {
    text = text.slice(0, SITUATION_CHAR_BUDGET - 20) + "\n…（已裁剪）";
  }
  return text;
}

// ─── Internal ─────────────────────────────────────────────────

function summarizeTask(t: Task): TaskSummary {
  const width = 60;
  return {
    id: t.id,
    state: t.state,
    agentDisplay: employeeDisplayName(t.agentName),
    agentName: t.agentName,
    promptSnippet: (t.brief ?? t.prompt).slice(0, width),
    ...(t.question ? { question: t.question } : {}),
    ...(t.error ? { error: t.error } : {}),
  };
}
