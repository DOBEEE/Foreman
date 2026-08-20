import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config/index.js";

/**
 * in-flight **boss 对话轮次**登记（注意与 inflight.ts 区分：那个管的是员工 run 的打断手柄）。
 *
 * 为什么需要：员工任务有状态机与 recoverCount，进程重启后会被 recoverInterruptedTasks
 * 重新派发；但 boss 自己的一轮对话不是 Task——它只活在内存里。进程一重启（生产上是崩溃/重部署，
 * 开发下是 tsx watch 跟随代码改动），那一轮就**静默消失**，用户只剩一个「👌 收到，正在看…」，
 * 永远等不到回复，也无从知道发生了什么。这是真实事故。
 *
 * 刻意**不自动重跑**：boss 的一轮里可能已经调过 dispatch_task / cancel_task 等有副作用的工具，
 * 重放会派两次活或重复取消。所以只把「静默丢失」变成「明确告知」，把重发的决定权交回用户。
 *
 * 按 chatId 单键：同一会话的 boss 轮次由 withChatLock 串行，不会并存两轮。
 */
export interface InflightTurn {
  channel: string;
  chatId: string;
  chatType: "private" | "group";
  ownerSenderId: string;
  ownerSenderName?: string;
  /** 用户那条消息原文，用于回执里复述「刚才那条…」 */
  text: string;
  startedAt: number;
}

function fileOf(): string {
  return join(config.runtimeDir, "boss", "inflight-turns.json");
}

function readAll(): Record<string, InflightTurn> {
  try {
    if (!existsSync(fileOf())) return {};
    const parsed = JSON.parse(readFileSync(fileOf(), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, InflightTurn>) : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, InflightTurn>): void {
  try {
    mkdirSync(dirname(fileOf()), { recursive: true });
    writeFileSync(fileOf(), JSON.stringify(map, null, 2));
  } catch {
    // 登记失败不能阻断对话主流程——最坏退化成「和以前一样静默丢」，不该让它变成新的故障源
  }
}

export function markTurnStart(turn: InflightTurn): void {
  const map = readAll();
  map[turn.chatId] = turn;
  writeAll(map);
}

export function markTurnEnd(chatId: string): void {
  const map = readAll();
  if (map[chatId] === undefined) return;
  delete map[chatId];
  writeAll(map);
}

/** 取出所有未收尾的轮次并清空登记（启动时调用一次） */
export function sweepInterruptedTurns(): InflightTurn[] {
  const map = readAll();
  const list = Object.values(map);
  if (list.length > 0) writeAll({});
  return list;
}
