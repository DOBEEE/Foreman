/**
 * 看板定时任务管理 API 的端到端回归（零 LLM，真起 express + createConsoleRouter）。
 *
 * **必须在独立 RUNTIME_DIR 下运行**：它会往 schedules.json 与 chats/ 写测试数据，
 * 跑在默认目录会动用户真实的定时任务（每日复盘/每周优化/GitHub 速报）且不会报错。
 *
 * 用法：RUNTIME_DIR=$(mktemp -d) npx tsx server/api/__fixtures__/check-schedule-api.ts
 */
import express from "express";
import { requireIsolatedRuntimeDir } from "../../team-bundle/__fixtures__/isolation-guard.js";

// 第一个写操作之前就拦住
requireIsolatedRuntimeDir("server/api/__fixtures__/check-schedule-api.ts");

const { createConsoleRouter } = await import("../dashboard.js");
const { createSchedule, getSchedule, listSchedules, updateSchedule, removeSchedule } = await import(
  "../../scheduler/schedule-store.js"
);
const { appendChatMessage } = await import("../../core/chat-store.js");

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fails.push(name);
}

const OWNER = "staff-001";
const CHAT_NEW = "staff-001"; // 归一化后的正确私聊 chatId（= ownerSenderId）
const CHAT_OLD = "cid-legacy-conversation-id="; // 事故形态：同一个人的老 chatId
const CHAT_UNKNOWN = "fixture:no-chat-record";

/** 造会话记录：ownerSenderId 只由「入站 + senderId」写入 */
function inbound(chatId: string, atIso: string): void {
  appendChatMessage({
    time: atIso,
    channel: "dingtalk",
    chatType: "private",
    chatId,
    direction: "in",
    senderId: OWNER,
    senderName: "测试用户",
    text: "在吗",
  });
}

// 老会话先说话，新会话后说话 → 新会话才是「用户最近所在」
inbound(CHAT_OLD, "2026-08-01T02:00:00.000Z");
inbound(CHAT_NEW, "2026-08-12T02:00:00.000Z");

function mk(over: Record<string, unknown>) {
  const result = createSchedule({
    title: "测试任务",
    // 用**内置**员工：assistant 是预置(presets/)员工，只在首次启动时播种到 runtimeDir，
    // 隔离目录里并不存在，会被启用路径的 agentExists 校验判成 409
    agentName: "default",
    prompt: "跑一次",
    timing: { kind: "daily", hour: 9, minute: 0 },
    channel: "dingtalk",
    chatId: CHAT_NEW,
    chatType: "private",
    ownerSenderId: OWNER,
    ownerSenderName: "测试用户",
    createdBy: "boss",
    ...over,
  } as Parameters<typeof createSchedule>[0]);
  if (!("schedule" in result)) throw new Error(`建 schedule 失败：${result.error}`);
  return result.schedule;
}

const A = mk({ title: "甲-正常" });
const B = mk({ title: "乙-依赖甲", dependsOn: A.id });
const C = mk({ title: "丙-员工不存在", agentName: "ghost-agent-not-exist" });
const D = mk({ title: "丁-会话无记录", chatId: CHAT_UNKNOWN });
const E = mk({ title: "戊-落在老会话", chatId: CHAT_OLD });

const app = express();
app.use("/api/console", createConsoleRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const address = server.address();
if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
const base = `http://127.0.0.1:${address.port}/api/console`;

async function json(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${base}${path}`, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, body };
}
const put = (id: string, enabled: boolean, extra: Record<string, unknown> = {}) =>
  json(`/schedules/${id}/enabled`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, ...extra }),
  });

const entryOf = (body: Record<string, any>, id: string) =>
  body.groups.flatMap((g: any) => g.schedules).find((e: any) => e.id === id);
const kindsOf = (body: Record<string, any>, id: string): string[] =>
  (entryOf(body, id)?.target.issues ?? []).map((i: any) => i.kind);

try {
  process.stdout.write("\n── 列表与派生字段 ──\n");
  const list = await json("/schedules");
  check("GET 200", list.status === 200);
  check("全量 5 条", list.body.stats?.total === 5, `实际 ${list.body.stats?.total}`);
  check(
    "按会话分成 3 组",
    list.body.groups?.length === 3,
    `实际 ${list.body.groups?.length}`,
  );
  const a = entryOf(list.body, A.id);
  check("timingText 用 describeTiming", a?.timingText === "每天 09:00", a?.timingText);
  check("agentLabel/agentMissing 正确", a?.agentMissing === false && !!a?.agentLabel);
  check("员工不存在被标出", entryOf(list.body, C.id)?.agentMissing === true);
  check(
    "dependents 反查",
    a?.dependents?.length === 1 && a.dependents[0].id === B.id,
  );
  check("dependsOnLabel 解析", entryOf(list.body, B.id)?.dependsOnLabel === "甲-正常");
  check(
    "failuresToAutoDisable 按 LIMITS 算",
    a?.failuresToAutoDisable === list.body.limits.maxConsecutiveFailures,
  );
  check(
    "DTO 不泄漏 Schedule 内部字段",
    a !== undefined && !("lastAccountedTaskId" in a) && !("lastRunKey" in a) && !("timing" in a),
  );

  process.stdout.write("\n── 投递目标异常判定 ──\n");
  check(
    "正常那条:只有同人多会话(老会话仍在盘上)",
    kindsOf(list.body, A.id).join(",") === "owner_multi_chat",
    kindsOf(list.body, A.id).join(",") || "(空)",
  );
  check("会话无记录 → chat_unknown", kindsOf(list.body, D.id).includes("chat_unknown"));
  check(
    "落在老会话 → boss_blind(主管看不见)",
    kindsOf(list.body, E.id).includes("boss_blind"),
    kindsOf(list.body, E.id).join(","),
  );
  check(
    "落在老会话 → chat_id_mismatch(钉钉私聊 chatId≠staffId)",
    kindsOf(list.body, E.id).includes("chat_id_mismatch"),
  );
  check(
    "在用户当前会话的不报 boss_blind",
    !kindsOf(list.body, A.id).includes("boss_blind"),
  );
  check("异常组置顶", list.body.groups[0].issueKinds.length >= 2);
  check(
    "siblings 列出同人的另一个会话",
    entryOf(list.body, A.id)?.target.siblings?.some((s: any) => s.chatId === CHAT_OLD),
  );

  process.stdout.write("\n── 停用 / 启用 ──\n");
  const off = await put(A.id, false);
  check("停用 200", off.status === 200);
  check("写入 disabledReason", getSchedule(A.id)?.disabledReason === "后台手动停用");
  check("停用不动 failCount(失败历史是排查素材)", getSchedule(A.id)?.failCount === 0);
  check(
    "停用被依赖者给出排序失效告警",
    (off.body.warnings ?? []).some((w: string) => w.includes("依赖")),
  );

  // 造退避 + 失败计数 + 矛盾的 disabledReason，验「启用」是否一次清干净
  updateSchedule(A.id, {
    failCount: 2,
    backoffUntil: Date.now() + 600_000,
    disabledReason: "连续失败 2 次",
  });
  const on = await put(A.id, true);
  check("启用 200", on.status === 200);
  const revived = getSchedule(A.id)!;
  check("启用清 failCount", revived.failCount === 0, String(revived.failCount));
  check(
    "启用清 backoffUntil(漏清会让它点了也不跑)",
    revived.backoffUntil === undefined,
    String(revived.backoffUntil),
  );
  check(
    "启用清 disabledReason(否则出现「已启用+停用原因」矛盾态)",
    revived.disabledReason === undefined,
    String(revived.disabledReason),
  );

  process.stdout.write("\n── 入参白名单与错误码 ──\n");
  const before = getSchedule(A.id)!;
  const inject = await put(A.id, true, { runCount: 9999, id: "hacked", lastTaskId: "x" });
  const after = getSchedule(A.id)!;
  check("注入请求本身仍 200", inject.status === 200);
  check("runCount 未被篡改", after.runCount === before.runCount, String(after.runCount));
  check("id 未被篡改", after.id === A.id);
  check("lastTaskId 未被篡改", after.lastTaskId === before.lastTaskId);
  check("enabled 非布尔 → 400", (await put(A.id, "yes" as unknown as boolean)).status === 400);
  check("不存在的 id → 404", (await put("nope12", true)).status === 404);
  check("启用员工已不存在的任务 → 409", (await put(C.id, true)).status === 409);

  process.stdout.write("\n── 删除的二段式 ──\n");
  updateSchedule(A.id, { seedKey: "builtin:test" });
  const blocked = await json(`/schedules/${A.id}`, { method: "DELETE" });
  check("有阻塞项 → 409", blocked.status === 409);
  check(
    "409 同时列出依赖与内置两条",
    String(blocked.body.error).includes("依赖") && String(blocked.body.error).includes("内置"),
    String(blocked.body.error).replace(/\n/g, " | "),
  );
  check("409 文案够短(要塞进 confirm，j<T> 只留 300 字)", String(blocked.body.error).length < 300);
  const forced = await json(`/schedules/${A.id}?force=1`, { method: "DELETE" });
  check("force=1 放行", forced.status === 200 && getSchedule(A.id) === undefined);
  const afterDel = await json("/schedules");
  check(
    "被删前置的依赖方标为 dependsOnMissing",
    entryOf(afterDel.body, B.id)?.dependsOnMissing === true,
  );
  check("删不存在的 → 404", (await json("/schedules/nope12", { method: "DELETE" })).status === 404);
  check(
    "无阻塞项可直接删",
    (await json(`/schedules/${D.id}`, { method: "DELETE" })).status === 200,
  );
} finally {
  server.close();
  for (const s of listSchedules()) removeSchedule(s.id);
}

process.stdout.write(
  fails.length === 0
    ? `\n━━━ ${pass}/${pass} 通过 ━━━\n`
    : `\n━━━ ${pass} 通过、${fails.length} 失败 ━━━\n${fails.map((f) => `  - ${f}`).join("\n")}\n`,
);
process.exit(fails.length === 0 ? 0 : 1);
