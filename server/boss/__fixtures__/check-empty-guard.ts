/**
 * 空输出守卫的**可达性**断言（零 LLM）。
 *
 * 为什么专门测这个：守卫第一版是死代码——runtime 检测到零输出时 yield 的是
 * `isError: true`，而 runTurn 的事件循环里 `if (r.isError) throw` 排在守卫之前，
 * 于是守卫永远执行不到（真实事故：8 秒失败直接抛给用户，用户只看到「本轮视为失败」）。
 * 修法是给这条结果加 `emptyOutput` 标记、让 runTurn 区别对待。
 *
 * 这类 bug 跑真模型测不出来——真模型大概率不会恰好空输出。所以用假 runtime 回放
 * 一段确定的事件序列，把「守卫到底有没有被执行」变成一条断言。
 */
import { runTurn } from "../boss-agent.js";
import { setRuntime } from "../../runtime/index.js";
import type { AgentRuntime, RuntimeEvent } from "../../runtime/types.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

/** 按脚本逐次回放事件的假 runtime，并记录每次 run 收到的 prompt */
function fakeRuntime(scripts: RuntimeEvent[][]): { prompts: string[] } {
  const prompts: string[] = [];
  let n = 0;
  setRuntime({
    async run(input: { prompt: string }) {
      prompts.push(input.prompt);
      const script = scripts[Math.min(n, scripts.length - 1)] ?? [];
      n += 1;
      return (async function* () {
        for (const ev of script) yield ev;
      })();
    },
    async complete() {
      return { text: "" };
    },
  } as unknown as AgentRuntime);
  return { prompts };
}

const EMPTY_RESULT: RuntimeEvent = {
  event: "result",
  data: {
    subtype: "error",
    isError: true,
    emptyOutput: true,
    result: "模型没有产生任何输出（无文本、无工具调用），本轮视为失败",
    sessionId: "sess-1",
  },
};

const BASE = { systemPrompt: "你是主管", prompt: "继续上次的图片域名替换的任务", tools: {}, actions: [] };

async function drive(): Promise<{
  threw: boolean;
  error: string;
  text: string;
  emptyOutput?: boolean;
}> {
  try {
    const out = await runTurn({ ...BASE });
    return { threw: false, error: "", text: out.text, ...(out.emptyOutput ? { emptyOutput: true } : {}) };
  } catch (e) {
    return { threw: true, error: e instanceof Error ? e.message : String(e), text: "" };
  }
}

process.stdout.write("\n── 空输出 → 重试救回 ──\n");
{
  const { prompts } = fakeRuntime([
    [EMPTY_RESULT],
    [
      { event: "text", data: { text: "我这边没有这条任务的记录，你说说具体要改哪个仓库？" } },
      { event: "result", data: { sessionId: "sess-1" } },
    ],
  ]);
  const out = await drive();
  check("带 emptyOutput 的结果没有当即抛出", !out.threw, out.error);
  check("守卫真的发起了第二次 run", prompts.length === 2, `实际 ${prompts.length} 次`);
  check(
    "重试用的是空输出提醒",
    (prompts[1] ?? "").includes("没有输出任何文字"),
    (prompts[1] ?? "").slice(0, 30),
  );
  check("重试文本成为最终回复", out.text.includes("没有这条任务的记录"), out.text.slice(0, 30));
  check("救回后不置 emptyOutput", !out.emptyOutput);
}

process.stdout.write("\n── 空输出 → 重试仍空 ──\n");
{
  const { prompts } = fakeRuntime([[EMPTY_RESULT], [EMPTY_RESULT]]);
  const out = await drive();
  check("仍然不抛（用户走友好兜底文案）", !out.threw, out.error);
  check("只重试一次，不无限重试", prompts.length === 2, `实际 ${prompts.length} 次`);
  check("text 为空", out.text === "", JSON.stringify(out.text));
  check("回传 emptyOutput 供日志标错", out.emptyOutput === true);
}

process.stdout.write("\n── 真错误（无 emptyOutput 标记）仍按原样抛 ──\n");
{
  const { prompts } = fakeRuntime([
    [
      {
        event: "result",
        data: { subtype: "error", isError: true, result: "[500] 网关炸了", sessionId: "s" },
      },
    ],
  ]);
  const out = await drive();
  check("抛出", out.threw, out.error);
  check("错误原文透传", out.error.includes("网关炸了"), out.error);
  check("不触发空输出重试", prompts.length === 1, `实际 ${prompts.length} 次`);
}

process.stdout.write("\n── 瞬态网关错误 → 原 session 退避重试 ──\n");
{
  const { prompts } = fakeRuntime([
    [
      {
        event: "result",
        data: {
          subtype: "error",
          isError: true,
          result: "[429] too many requests",
          sessionId: "sess-retry",
          retryable: true,
          errorSource: "model_gateway",
          statusCode: 429,
        },
      },
    ],
    [
      { event: "text", data: { text: "现在可以正常回复。" } },
      { event: "result", data: { subtype: "success", isError: false, sessionId: "sess-retry" } },
    ],
  ]);
  const out = await drive();
  check("限流未直接抛给用户", !out.threw, out.error);
  check("在同一轮内部自动重试", prompts.length === 2, `实际 ${prompts.length} 次`);
  check("恢复提示要求避免重复动作", prompts[1]?.includes("已经成功的动作不要重复执行") === true);
  check("重试成功结果成为最终回复", out.text === "现在可以正常回复。", out.text);
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
