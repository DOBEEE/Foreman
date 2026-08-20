/**
 * 任务档案的结构性校验（零 LLM，纯断言）。
 *
 * 为什么值得单独测：
 * 1. **档案是唯一的长期事实源**。终态钩子会重放同一个任务（验收返工 / retryFailed /
 *    重启补交接），读侧「后写的赢」这条一旦被改坏，员工与主管查到的就是过期结论。
 * 2. **员工作用域是安全边界**：`scopeAgent` 一给就只能查自己的，越权必须表现为「没有」
 *    而不是「不给你看」——后者等于确认了那条记录的存在。
 * 3. **注入摘要必须排掉当前会话**：否则同一批任务会和工作台索引重复一遍，白占注入窗口。
 *
 * 隔离手法：所有 fixture 记录的 `at` 都落在 1970 年，于是只会写进 1970-0x.jsonl
 * 这两个分片，收尾整文件删掉即可——绝不碰真实月份的档案。
 *
 * 用法：npx tsx server/core/__fixtures__/check-task-archive.ts
 */

import { appendFileSync, existsSync, rmSync } from "node:fs";
import {
  appendTaskArchive,
  archiveFileOf,
  getTaskArchiveRecord,
  renderRecentArchive,
  searchTaskArchive,
  type TaskArchiveRecord,
} from "../task-archive.js";
import { buildGetTaskRecordTool, buildSearchTaskHistoryTool } from "../../runtime/tools/task-history.js";

const AGENT = "fx-archive-agent";
const OTHER_AGENT = "fx-archive-other";
const CHAT = "fixture:archive:chat-a";
const OTHER_CHAT = "fixture:archive:chat-b";
/** 1970-01-02 与 1970-02-02：刻意落在真实数据之外的两个月份分片 */
const JAN = 86400_000 * 1;
const FEB = 86400_000 * 32;
const MONTHS = ["1970-01", "1970-02"];

let pass = 0;
const fails: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    process.stdout.write(`  ✅ ${label}\n`);
  } else {
    fails.push(`${label}${detail ? ` — ${detail}` : ""}`);
    process.stdout.write(`  ❌ ${label}${detail ? ` — ${detail}` : ""}\n`);
  }
}

function rec(taskId: string, extra: Partial<TaskArchiveRecord> = {}): TaskArchiveRecord {
  return {
    taskId,
    chatId: CHAT,
    at: JAN,
    state: "done",
    agentName: AGENT,
    title: `任务 ${taskId}`,
    conclusion: `${taskId} 的结论`,
    ...extra,
  };
}

function cleanup(): void {
  for (const m of MONTHS) {
    const f = archiveFileOf(m);
    if (existsSync(f)) rmSync(f);
  }
}

/** 只取 fixture 自己的记录：档案是共享文件，真实数据也在里面 */
function mine(agentName = AGENT) {
  return searchTaskArchive({ agentName, limit: 50 });
}

async function main(): Promise<void> {
  cleanup();

  process.stdout.write("\n── 落档与读回 ──\n");
  appendTaskArchive(rec("a1"));
  appendTaskArchive(rec("a2", { at: JAN + 1000 }));
  const two = mine();
  check("两条都在（append 没互相覆盖）", two.length === 2, String(two.length));
  check("按时间倒序（新的在前）", two[0]?.taskId === "a2", two.map((r) => r.taskId).join(","));

  process.stdout.write("\n── 按月分片 ──\n");
  appendTaskArchive(rec("b1", { at: FEB }));
  check("1 月分片存在", existsSync(archiveFileOf("1970-01")));
  check("2 月分片单独成文件", existsSync(archiveFileOf("1970-02")));
  check("跨月能一起查出来", mine().length === 3, String(mine().length));

  process.stdout.write("\n── 同一任务重复落档：读时后写的赢 ──\n");
  // 三条路都会重放：验收返工 / retryFailed / 重启补交接
  appendTaskArchive(rec("a1", { at: FEB + 5000, state: "failed", conclusion: "返工后的结论" }));
  const a1 = getTaskArchiveRecord("a1");
  check("取到最新那条", a1?.conclusion === "返工后的结论", String(a1?.conclusion));
  check("状态也是最新的", a1?.state === "failed", String(a1?.state));
  check("查询结果里不出现两条 a1", mine().filter((r) => r.taskId === "a1").length === 1);

  process.stdout.write("\n── 过滤条件 ──\n");
  check("keyword 命中结论", searchTaskArchive({ agentName: AGENT, keyword: "返工后" }).length === 1);
  check("keyword 不区分大小写", searchTaskArchive({ agentName: AGENT, keyword: "任务 A2" }).length === 1);
  check("state 过滤", searchTaskArchive({ agentName: AGENT, state: "failed" }).every((r) => r.state === "failed"));
  appendTaskArchive(rec("c1", { chatId: OTHER_CHAT, at: JAN + 2000 }));
  check("chatId 过滤", searchTaskArchive({ agentName: AGENT, chatId: OTHER_CHAT }).length === 1);
  check(
    "excludeChatId 排掉当前会话（注入不与工作台索引重复）",
    searchTaskArchive({ agentName: AGENT, excludeChatId: CHAT }).every((r) => r.chatId === OTHER_CHAT),
  );
  check("since 早于全部记录 → 全中", searchTaskArchive({ agentName: AGENT, since: "1970-01-01" }).length === 4);
  check("since 晚于全部记录 → 空", searchTaskArchive({ agentName: AGENT, since: "2000-01-01" }).length === 0);
  check("limit 生效", searchTaskArchive({ agentName: AGENT, limit: 2 }).length === 2);
  check("limit 有硬上限（要进模型上下文，不能无界）", searchTaskArchive({ agentName: AGENT, limit: 9999 }).length <= 50);

  process.stdout.write("\n── 员工间隔离 ──\n");
  appendTaskArchive(rec("d1", { agentName: OTHER_AGENT, at: JAN + 3000 }));
  check("别人的记录不进我的结果", mine().every((r) => r.agentName === AGENT));
  check("他自己能查到", mine(OTHER_AGENT).length === 1);

  process.stdout.write("\n── 注入摘要 ──\n");
  const injected = renderRecentArchive(AGENT, { excludeChatId: CHAT }) ?? "";
  check("含任务号", injected.includes("#c1"), injected);
  check("排掉了当前会话的记录", !injected.includes("#a2"), injected);
  check("无记录时返回 undefined（调用方据此决定整段是否出现）", renderRecentArchive("fx-archive-nobody") === undefined);

  process.stdout.write("\n── 字段截断（一条动辄几 KB 会让整月读回变成读几十兆）──\n");
  appendTaskArchive(rec("e1", { at: JAN + 4000, conclusion: "x".repeat(5000), title: "t".repeat(500) }));
  const long = getTaskArchiveRecord("e1");
  check("结论被截断", (long?.conclusion?.length ?? 0) < 1000, String(long?.conclusion?.length));
  check("标题被截断", (long?.title.length ?? 0) < 200, String(long?.title.length));

  process.stdout.write("\n── 坏行不该让整段历史消失 ──\n");
  appendFileSync(archiveFileOf("1970-01"), "这不是 json\n", "utf-8");
  appendFileSync(archiveFileOf("1970-01"), `${JSON.stringify({ state: "done" })}\n`, "utf-8");
  check("坏行与缺 taskId 的行都跳过", mine().length === 5, String(mine().length));

  process.stdout.write("\n── 工具层：作用域是硬的 ──\n");
  const scoped = buildSearchTaskHistoryTool(AGENT);
  const scopedOut = String(await scoped.execute!({ keyword: "任务" } as never, {} as never));
  check("员工查到自己的", scopedOut.includes("#a2"), scopedOut.slice(0, 120));
  check("查不到别人的", !scopedOut.includes("#d1"), scopedOut.slice(0, 120));
  const scopedGet = buildGetTaskRecordTool(AGENT);
  const cross = String(await scopedGet.execute!({ taskId: "d1" } as never, {} as never));
  check("越权取别人档案 → 回「没有」而不是「不给看」", cross.includes("没有") && !cross.includes("无权"), cross);
  const bossGet = buildGetTaskRecordTool();
  check("主管不限作用域", String(await bossGet.execute!({ taskId: "d1" } as never, {} as never)).includes("d1"));
  const missing = String(await scopedGet.execute!({ taskId: "nope" } as never, {} as never));
  check("不存在的任务号给出可行动的解释", missing.includes("还没收尾") || missing.includes("任务号不对"), missing);

  cleanup();
  check("收尾后 fixture 分片已删（没污染真实档案）", !existsSync(archiveFileOf("1970-01")));

  process.stdout.write(`\n━━━ ${pass}/${pass + fails.length} 通过 ━━━\n`);
  if (fails.length > 0) {
    process.stdout.write(`未通过：\n${fails.map((f) => `  - ${f}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}

void main();
