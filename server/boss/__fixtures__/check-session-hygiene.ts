/**
 * 会话中毒防线（零 LLM）。
 *
 * 锁住的根因：assistant 消息里的 reasoning（thinking）块带 anthropic signature，
 * 跨轮回放会把**不属于本会话的内容**注入上下文。实测同一份历史、同一个模型：
 * 带 reasoning 重放答出会话里根本没出现过的人和事，剥掉就立刻正常。
 *
 * 这类 bug 的隐蔽点在于 pruneEmptyMessages 挡不住它——只含 reasoning 的 assistant 消息
 * content 是**非空数组**，一路放行到落盘，此后每次 resume 都带着毒。
 */
import {
  pruneEmptyMessages,
  sanitizeSessionMessages,
  stripReasoningParts,
  type SessionMessage,
} from "../../runtime/session-store.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

const SIG = { anthropic: { signature: "EuQDCnEIEBABGAIq..." } };

/** 复现线上那条毒消息：只有 reasoning、没有 text/tool-call */
const reasoningOnly: SessionMessage = {
  role: "assistant",
  content: [{ type: "reasoning", text: "我查了一下任务记录…", providerOptions: SIG }],
};
/** 正常的一轮：thinking + tool-call */
const thinkingPlusTool: SessionMessage = {
  role: "assistant",
  content: [
    { type: "reasoning", text: "先查任务列表", providerOptions: SIG },
    { type: "tool-call", toolCallId: "t1", toolName: "list_tasks", input: {} },
  ],
};
/** 正常的一轮：thinking + text */
const thinkingPlusText: SessionMessage = {
  role: "assistant",
  content: [
    { type: "reasoning", text: "该怎么答", providerOptions: SIG },
    { type: "text", text: "我这边没有这条记录" },
  ],
};
const userMsg: SessionMessage = { role: "user", content: "继续上次的任务" };
const toolMsg: SessionMessage = {
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "t1", toolName: "list_tasks", output: "无" }],
};

process.stdout.write("\n── pruneEmptyMessages 挡不住毒消息（这正是它漏过去的原因）──\n");
{
  const kept = pruneEmptyMessages([reasoningOnly]);
  check("只含 reasoning 的消息能通过旧过滤器", kept.length === 1, `剩 ${kept.length} 条`);
}

process.stdout.write("\n── stripReasoningParts ──\n");
{
  const out = stripReasoningParts([userMsg, thinkingPlusTool, toolMsg, reasoningOnly, thinkingPlusText]);
  check("只含 reasoning 的消息被整条丢弃", out.length === 4, `剩 ${out.length} 条`);
  const anyReasoning = out.some(
    (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((p) => p?.type === "reasoning"),
  );
  check("产物里不再有任何 reasoning 块", !anyReasoning);
  const tool = out[1];
  check(
    "thinking+tool-call 的 tool-call 保留",
    Array.isArray(tool?.content) &&
      (tool.content as Array<{ type?: string }>).some((p) => p.type === "tool-call"),
  );
  const txt = out[3];
  check(
    "thinking+text 的 text 保留",
    Array.isArray(txt?.content) &&
      (txt.content as Array<{ type?: string }>).some((p) => p.type === "text"),
  );
  check("user 消息原样保留", out[0]?.role === "user" && out[0]?.content === "继续上次的任务");
  check("tool 结果原样保留", out[2]?.role === "tool");
}

process.stdout.write("\n── 幂等与不破坏字符串 content ──\n");
{
  const once = stripReasoningParts([thinkingPlusText]);
  const twice = stripReasoningParts(once);
  check("重复清洗结果稳定（loadSession 每次加载都会跑）", JSON.stringify(once) === JSON.stringify(twice));
  const plain: SessionMessage[] = [{ role: "assistant", content: "纯文本回复" }];
  check("字符串 content 不受影响", stripReasoningParts(plain)[0]?.content === "纯文本回复");
}

process.stdout.write("\n── sanitizeSessionMessages = 剥 thinking + 剔空 ──\n");
{
  const out = sanitizeSessionMessages([
    reasoningOnly,
    { role: "assistant", content: "" },
    { role: "assistant", content: [] },
    { role: "assistant", content: null },
    thinkingPlusText,
    userMsg,
  ]);
  check("毒消息与各类空消息全部清掉", out.length === 2, `剩 ${out.length} 条`);
  check("留下的是有内容的那两条", out[0]?.role === "assistant" && out[1]?.role === "user");
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
