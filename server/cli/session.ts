import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";

const stateDir = join(config.runtimeDir, "cli");
const lastSessionFile = join(stateDir, "last-session.json");

export interface LastSession {
  /** 锚点会话 ID（普通 agent 的会话 / workflow 的答疑会话） */
  sessionId?: string;
  /** workflow 任务档案 ID */
  taskId?: string;
  agent: string;
  time: string;
}

export function saveLastSession(
  data: Omit<LastSession, "time">,
): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      lastSessionFile,
      JSON.stringify({ ...data, time: new Date().toISOString() }),
    );
  } catch {
    // 会话记录失败不影响主流程
  }
}

export function loadLastSession(): LastSession | undefined {
  try {
    return JSON.parse(readFileSync(lastSessionFile, "utf-8")) as LastSession;
  } catch {
    return undefined;
  }
}

/* ── 会话历史（/resume 列表数据源） ── */

const historyFile = join(stateDir, "sessions.jsonl");
const HISTORY_LIMIT = 100;

export interface SessionEntry {
  sessionId?: string;
  taskId?: string;
  agent: string;
  /** 会话首条用户输入，列表展示用 */
  firstPrompt: string;
  time: string;
}

/** 追加/更新一条会话历史（同 sessionId/taskId 视为同一会话，更新时间） */
export function recordSession(entry: Omit<SessionEntry, "time">): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const sessions = listSessions().filter(
      (s) =>
        !(
          (entry.sessionId && s.sessionId === entry.sessionId) ||
          (entry.taskId && s.taskId === entry.taskId)
        ),
    );
    sessions.push({ ...entry, time: new Date().toISOString() });
    const kept = sessions.slice(-HISTORY_LIMIT);
    writeFileSync(
      historyFile,
      kept.map((s) => JSON.stringify(s)).join("\n") + "\n",
    );
  } catch {
    // 历史记录失败不影响主流程
  }
}

/** 全部会话历史（时间升序）；传 agent 则过滤 */
export function listSessions(agent?: string): SessionEntry[] {
  try {
    const lines = readFileSync(historyFile, "utf-8").split("\n").filter(Boolean);
    const all = lines.map((l) => JSON.parse(l) as SessionEntry);
    return agent ? all.filter((s) => s.agent === agent) : all;
  } catch {
    return [];
  }
}
