/**
 * Qoder runtime 接线回归（零 LLM，纯断言）。
 *
 * 覆盖三处「坏了不会报错、只会静默走错」的地方：
 * 1. `--runtime` 参数解析与非法值早失败；
 * 2. runtime 工厂按 kind 选实现（选错 = 整个进程用错后端，且表现只是「模型不对劲」）；
 * 3. **事件翻译**：Qoder 消息 → AgentEvent。这层错了的表现是「任务在跑但 boss 收不到任何东西」，
 *    靠真模型极难复现——尤其 `system/init` 漏转 session 事件会让 resume 永久失效
 *    （boss 靠它落盘 sessionId，见 boss.ts 的 runWorker）。
 *
 * 用法：npx tsx server/runtime/__fixtures__/check-qoder-runtime.ts
 */

import { parseArgs } from "../../cli/args.js";
import { isRuntimeKind } from "../types.js";
import {
  translateMessage,
  stripMcpPrefix,
  buildCanUseTool,
  resolveQoderTools,
  hasSubagentTool,
  looksLikeInvalidSession,
} from "../qoder-runtime.js";
import { resumableSessionId } from "../../boss/types.js";
import { buildQoderProtocolServer, qualifiedName } from "../qoder-protocol-tools.js";
import { buildAskUserTool, buildSubmitPlanTool } from "../tools/protocol-tools.js";
import type { SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import type { RuntimeEvent } from "../types.js";
import type { ToolGuard } from "../hooks.js";

let pass = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    process.stdout.write(`  ✅ ${name}\n`);
  } else {
    fails.push(name);
    process.stdout.write(`  ❌ ${name}${detail ? `：${detail}` : ""}\n`);
  }
}

/** 伪造消息只需带被翻译读到的字段，形状按 protocol/messages.d.ts 对齐 */
const msg = (o: Record<string, unknown>): SDKMessage => o as unknown as SDKMessage;

function events(m: Record<string, unknown>): RuntimeEvent[] {
  return translateMessage(msg(m));
}

async function main(): Promise<void> {
  process.stdout.write("\n── 启动参数 --runtime ──\n");
  check("--runtime=qoder 解析成 qoder", parseArgs(["--runtime=qoder"]).runtime === "qoder");
  check("--runtime=vercel 解析成 vercel", parseArgs(["--runtime=vercel"]).runtime === "vercel");
  check("不给则为 undefined（由 env/默认兜底）", parseArgs([]).runtime === undefined);
  let threw = false;
  try {
    parseArgs(["--runtime=gpt"]);
  } catch {
    threw = true;
  }
  check("非法取值早失败（不静默回落）", threw);
  check("isRuntimeKind 只认两种", isRuntimeKind("qoder") && !isRuntimeKind("claude"));

  process.stdout.write("\n── 事件翻译：session（resume 的命脉）──\n");
  const initEvents = events({ type: "system", subtype: "init", session_id: "sess-abc" });
  check(
    "system/init → session 事件且带 sessionId",
    initEvents.length === 1 &&
      initEvents[0].event === "session" &&
      initEvents[0].data.sessionId === "sess-abc",
    JSON.stringify(initEvents),
  );
  check(
    "非 init 的 system 不产生事件",
    events({ type: "system", subtype: "other", session_id: "x" }).length === 0,
  );

  process.stdout.write("\n── 事件翻译：assistant 内容块 ──\n");
  const asst = events({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "分析中" },
        { type: "thinking", thinking: "内心戏" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
  });
  check("text 块 → text", asst[0]?.event === "text" && asst[0].data.text === "分析中");
  check("thinking 块 → thinking", asst[1]?.event === "thinking");
  check(
    "tool_use 块 → tool_call（带 id/name/input）",
    asst[2]?.event === "tool_call" &&
      asst[2].data.id === "t1" &&
      asst[2].data.name === "Bash",
    JSON.stringify(asst[2]),
  );

  process.stdout.write("\n── 事件翻译：工具结果 ──\n");
  const tr = events({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content: "out", is_error: true }],
    },
  });
  check(
    "tool_result → tool_result（带 toolUseId 与 isError）",
    tr[0]?.event === "tool_result" &&
      tr[0].data.toolUseId === "t1" &&
      tr[0].data.isError === true,
    JSON.stringify(tr),
  );

  process.stdout.write("\n── 协议工具：前缀剥离（boss/lead 匹配的命脉）──\n");
  check("裸名不受影响", stripMcpPrefix("Bash") === "Bash");
  check(
    "自己那台 server 的前缀被剥掉",
    stripMcpPrefix(qualifiedName("ask_user")) === "ask_user",
    qualifiedName("ask_user"),
  );
  check(
    "外部 MCP 工具的前缀必须保留（前缀是它的身份）",
    stripMcpPrefix("mcp__yuque__read_doc") === "mcp__yuque__read_doc",
  );
  // 端到端：模型调的是全名，翻译后必须还原成 boss 能认的裸名
  const askCall = events({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "a1", name: qualifiedName("ask_user"), input: { questions: [] } },
      ],
    },
  });
  check(
    "tool_call 事件里已是裸名 ask_user",
    askCall[0]?.event === "tool_call" && askCall[0].data.name === "ask_user",
    JSON.stringify(askCall[0]),
  );
  const submitCall = events({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "s1", name: qualifiedName("submit_plan"), input: {} }],
    },
  });
  check(
    "submit_plan 同样还原（lead.agent.ts 按裸名捕获编队计划）",
    submitCall[0]?.data.name === "submit_plan",
  );

  process.stdout.write("\n── 协议工具：Vercel → Qoder 套壳 ──\n");
  const converted = buildQoderProtocolServer({
    ask_user: buildAskUserTool(() => {}),
    submit_plan: buildSubmitPlanTool(async () => "ok"),
  });
  check(
    "全名清单用于 allowedTools 授权",
    converted.qualifiedNames.includes("mcp__foreman__ask_user") &&
      converted.qualifiedNames.includes("mcp__foreman__submit_plan"),
    JSON.stringify(converted.qualifiedNames),
  );
  check("产出了 in-process MCP server", Boolean(converted.server));

  process.stdout.write("\n── 事件翻译：result 成功/失败 ──\n");
  const ok = events({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "干完了",
    session_id: "s1",
    num_turns: 7,
    duration_ms: 1234,
  });
  check(
    "成功 result 带 result/sessionId/numTurns",
    ok[0]?.event === "result" &&
      ok[0].data.isError === false &&
      ok[0].data.result === "干完了" &&
      ok[0].data.sessionId === "s1" &&
      ok[0].data.numTurns === 7,
    JSON.stringify(ok[0]),
  );

  // 断流类错误必须判 retryable，否则编队 runDelegate / boss 主干的自动重试都不会触发
  const dropped = events({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["terminated"],
    session_id: "s2",
  });
  check(
    "断流（terminated）判 isError + retryable",
    dropped[0]?.data.isError === true && dropped[0]?.data.retryable === true,
    JSON.stringify(dropped[0]),
  );
  const authFail = events({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["401 unauthorized"],
  });
  check(
    "鉴权失败不判 retryable（重试没意义）",
    authFail[0]?.data.isError === true && authFail[0]?.data.retryable === false,
    JSON.stringify(authFail[0]),
  );
  check(
    "max_turns 也算失败（subtype 非 success）",
    events({ type: "result", subtype: "error_max_turns", is_error: true, errors: [] })[0]?.data
      .isError === true,
  );

  process.stdout.write("\n── 门禁：ToolGuard → canUseTool ──\n");
  // guard 按裸名匹配，而 Qoder 传进来的协议工具是全名——不剥前缀会让 guard 全部失配
  const seenNames: string[] = [];
  const recorder: ToolGuard = async (n) => {
    seenNames.push(n);
    return n === "Bash" ? { deny: true, reason: "禁止执行命令" } : { allow: true };
  };
  const cut = buildCanUseTool([recorder]);
  check(
    "guard deny → behavior:deny 且带原因",
    await (async () => {
      const r = await cut("Bash", { command: "rm -rf /" });
      return r.behavior === "deny" && "message" in r && r.message.includes("禁止执行命令");
    })(),
  );
  check(
    "guard allow → behavior:allow",
    (await cut("Read", { file_path: "/tmp/a" })).behavior === "allow",
  );
  await cut(qualifiedName("ask_user"), {});
  check(
    "送进 guard 的是裸名（不是 mcp__foreman__ 全名）",
    seenNames.includes("ask_user") && !seenNames.some((n) => n.startsWith("mcp__foreman__")),
    JSON.stringify(seenNames),
  );
  check(
    "零 guard 时一律放行（必须提供回调，否则 CLI 无人审批会全拒）",
    (await buildCanUseTool([])("Bash", { command: "ls" })).behavior === "allow",
  );

  process.stdout.write("\n── 工具白名单：子代理绕过面 ──\n");
  // 安全不变式：不传 tools 就等于沿用 CLI 默认工具集（含 Agent），
  // 而子代理内部的调用未必过 canUseTool → 门禁出现缺口。所以缺省必须是显式安全集。
  const dflt = resolveQoderTools(undefined);
  check(
    "builtinAllow 为空时给出显式缺省集（不留空交给 CLI）",
    dflt.length > 0 && dflt.includes("Read") && dflt.includes("Bash"),
    JSON.stringify(dflt),
  );
  check("缺省集不含 Agent/Task（绕过面默认关闭）", !hasSubagentTool(dflt), JSON.stringify(dflt));
  check(
    "岗位声明的白名单被原样尊重（只读岗仍只读）",
    JSON.stringify(resolveQoderTools(["Read", "Grep"])) === JSON.stringify(["Read", "Grep"]),
  );
  check(
    "显式声明 Agent 时能被识别（供告警留痕）",
    hasSubagentTool(resolveQoderTools(["Read", "Agent"])),
  );

  process.stdout.write("\n── 会话隔离：跨 runtime 的 sessionId 不得复用 ──\n");
  // 线上故障根因：boss 拿 Vercel 时代的 id 去 Qoder resume → worker exit 42
  // `Invalid session identifier`，且脏 id 留在库里导致每一轮都失败。
  check(
    "同源才可 resume",
    resumableSessionId({ sessionId: "s1", sessionRuntime: "qoder" }, "qoder") === "s1",
  );
  check(
    "异源一律不 resume（vercel 的 id 不给 qoder）",
    resumableSessionId({ sessionId: "s1", sessionRuntime: "vercel" }, "qoder") === undefined,
  );
  check(
    "无归属（切 runtime 前的老任务）不 resume",
    resumableSessionId({ sessionId: "s1" }, "qoder") === undefined,
  );
  check("没有 sessionId 自然不 resume", resumableSessionId({}, "qoder") === undefined);
  check(
    "无效 session 的 stderr 特征可识别（触发丢弃 resume 重试）",
    looksLikeInvalidSession('Error resuming session: Invalid session identifier "41ec4b6f".'),
  );
  check(
    "普通错误不会被误判成无效 session",
    !looksLikeInvalidSession("terminated") && !looksLikeInvalidSession("[401] unauthorized"),
  );

  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

void main();
