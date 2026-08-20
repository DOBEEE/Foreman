/**
 * 编队步骤瞬态断连自动重试回归（零 LLM，纯断言）。
 *
 * 背景（线上事故 task 2a1839）：编队三步（diagnose/fix/verify）各自跑了 15/19/3 分钟后
 * 都以 `terminated` 收场、零产出。根因是到模型网关的流式连接被 idle 超时中途掐断
 * （undici 抛 `TypeError: terminated`），而 runDelegate 早先既不识别 result 事件里的
 * isError、也不重试——一次抖动就把整步判失败；执行器「跳过失败步继续」又把连环断连
 * 伪装成「整个 squad 一次性被 kill」。
 *
 * 这里用假 agent（不碰模型）钉住修复后的语义：
 * 1. retryable 的 result 错误 → 在原会话 resume 重试，最终成功；
 * 2. 非 retryable 的 result 错误 → 立即抛出（让步骤如实判失败，不把空产出当成品）；
 * 3. abortController 已 abort（用户打断）→ 立即抛出、不重试。
 *
 * 用法：npx tsx server/agents/squad/__fixtures__/check-squad-retry.ts
 */

import { runDelegate, type SquadRuntime } from "../executor.js";
import type { AgentEvent } from "../../../core/runner.js";

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

/** 造一个按脚本逐轮产出事件的假 agent；把每轮收到的 resume 值记进 resumes */
function fakeAgent(rounds: AgentEvent[][], resumes: (string | undefined)[]) {
  let i = 0;
  return {
    async *run(input: Record<string, unknown>): AsyncGenerator<AgentEvent> {
      resumes.push(input.resume as string | undefined);
      const evts = rounds[Math.min(i, rounds.length - 1)];
      i++;
      for (const e of evts) yield e;
    },
  };
}

function baseRt(abort?: AbortController): SquadRuntime {
  return {
    leadName: "lead",
    cwd: "/tmp/fixture-squad",
    baseParams: {},
    depth: 0,
    ...(abort ? { abortController: abort } : {}),
  };
}

const errResult = (msg: string, retryable: boolean, sessionId = "sess-1"): AgentEvent => ({
  event: "result",
  data: { subtype: "error", isError: true, result: msg, retryable, sessionId },
});
const okResult = (text: string, sessionId = "sess-1"): AgentEvent[] => [
  { event: "text", data: { text } },
  { event: "result", data: { subtype: "success", isError: false, sessionId } },
];

async function main(): Promise<void> {
  process.stdout.write("\n── 瞬态断连（terminated）自动重试 ──\n");
  {
    const resumes: (string | undefined)[] = [];
    // 第 1 轮：terminated（retryable）；第 2 轮：成功
    const agent = fakeAgent([[errResult("terminated", true)], okResult("修复完成")], resumes);
    const out = await runDelegate(baseRt(), agent, "brief", {});
    check("重试后拿到成功产出", out.text === "修复完成", out.text);
    check("第二轮带上了上一轮的 sessionId 续跑", resumes[1] === "sess-1", JSON.stringify(resumes));
  }

  process.stdout.write("\n── 非瞬态错误：立即失败，不吞成空产出 ──\n");
  {
    let threw = "";
    const agent = fakeAgent([[errResult("[401] auth failed", false)]], []);
    try {
      await runDelegate(baseRt(), agent, "brief", {});
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check("非 retryable 错误直接抛出", threw.includes("auth failed"), threw);
  }

  process.stdout.write("\n── 用户打断：立即停，不重试 ──\n");
  {
    const abort = new AbortController();
    abort.abort();
    let threw = "";
    const agent = fakeAgent([[errResult("terminated", true)]], []);
    try {
      await runDelegate(baseRt(abort), agent, "brief", {});
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check("已 abort 时即便 retryable 也立即抛出", threw.includes("terminated"), threw);
  }

  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

void main();
