/**
 * 中断恢复基础设施回归（零 LLM）。运行时请给独立 RUNTIME_DIR，避免碰真实任务数据。
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config/index.js";
import {
  loadSession,
  saveSession,
  type SessionState,
} from "../../runtime/session-store.js";
import { TaskManager } from "../task-manager.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

process.stdout.write("\n── session 原子覆盖与 checkpoint 回放 ──\n");
const now = Date.now();
const state: SessionState = {
  id: "recovery-fixture",
  messages: [{ role: "user", content: "原始需求" }],
  activatedSkills: [],
  tokenEstimate: 3,
  createdAt: now,
  lastActiveAt: now,
  checkpoint: { state: "running", completedSteps: 0, updatedAt: now },
};
saveSession(state);
state.messages.push({ role: "assistant", content: "第一步完成" });
state.checkpoint = { state: "interrupted", completedSteps: 1, updatedAt: Date.now() };
saveSession(state);
const loaded = loadSession(state.id);
check("覆盖后仍是完整 JSON", loaded?.messages.length === 2);
check("中断检查点可回放", loaded?.checkpoint?.state === "interrupted" && loaded.checkpoint.completedSteps === 1);
const sessionDir = join(config.runtimeDir, "sessions");
const tempFiles = existsSync(sessionDir)
  ? readdirSync(sessionDir).filter((name) => name.endsWith(".tmp"))
  : [];
check("原子 rename 后没有临时文件残留", tempFiles.length === 0, tempFiles.join(","));

process.stdout.write("\n── failed 任务原地复活 ──\n");
const tm = new TaskManager();
const common = {
  channel: "fixture",
  chatId: `recovery-chat-${process.pid}`,
  chatType: "private" as const,
  ownerSenderId: "u1",
  ownerSenderName: "tester",
  agentName: "coder",
};
const first = tm.create({ ...common, prompt: "任务一" }).task;
tm.update(common.chatId, first.id, { sessionId: "sess-old" });
tm.markFailed(common.chatId, first.id, "[429] too many requests");
const retried = tm.retryFailed(common.chatId, first.id);
check("重试复用原 taskId", retried?.task.id === first.id);
check("重试保留原 sessionId", retried?.task.sessionId === "sess-old");
check("员工空闲时原任务直接 running", retried?.startNow === true && retried?.task.state === "running");
check("失败原因和重试计数被清理", retried?.task.error == null && retried?.task.errorRetries === 0);

const queued = tm.create({ ...common, prompt: "任务二" }).task;
tm.markFailed(common.chatId, queued.id, "临时错误");
// 先把这个员工的槽位占满再重试。**不能假设他只有一个槽**：coder 声明了 maxParallel，
// 原先写死「有一个 running 就算忙」的断言会随配置漂掉，而它要测的性质是「槽满就排队」。
const fillers: string[] = [];
for (let i = 0; tm.freeSlots(common.chatId, common.agentName) > 0 && i < 16; i++) {
  fillers.push(tm.create({ ...common, prompt: `占位 ${i}` }).task.id);
}
check("已把该员工的槽位占满", tm.freeSlots(common.chatId, common.agentName) <= 0);
const queuedRetry = tm.retryFailed(common.chatId, queued.id);
check("员工槽位占满时原任务回 queued", queuedRetry?.startNow === false && queuedRetry?.task.state === "queued");

// 清掉本次造出来的任务库：这个 fixture 往**真实** runtimeDir 写任务，跑完会剩下一个
// running + 一个 queued。而 bossRecover 启动时会把 running 任务重新派发——不清的话
// 每次服务重启都会真的拉起一次 coder 去跑「任务一」，白烧 token。只删自己那一个文件。
const storeFile = join(config.runtimeDir, "boss", `${common.chatId}.json`);
if (existsSync(storeFile)) rmSync(storeFile);
check("收尾清掉了自己的任务库（否则每次重启都会被真的拉起来跑）", !existsSync(storeFile));

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail) process.exitCode = 1;
