import type { CliArgs } from "./args.js";
import { startLocalBackend, type LocalBackend } from "./backend.js";
import { runAgentStream, runBossWait } from "./client.js";
import { loadLastSession, saveLastSession } from "./session.js";
import { CLI_DEFAULT_CHAT_ID } from "../channels/types.js";
import { credentialGuidance, hasUsableModel } from "../core/onboarding.js";

/** -p 模式：单次执行，文本流写 stdout、工具调用写 stderr，结束后退出 */
export async function runHeadless(args: CliArgs): Promise<void> {
  // 缺凭据先拦下来：照常跑只会把引导文案混进正常输出，而 -p 的调用方多半是脚本 ——
  // 它分不清「引导」和「结果」，只能看退出码。--remote 除外：凭据在远端那台机器上。
  if (!args.remote && !hasUsableModel()) {
    process.stderr.write(`${credentialGuidance()}\n\n跑 foreman setup 可在命令行里配完。\n`);
    process.exit(1);
  }

  let backend: LocalBackend | undefined;
  const baseUrl = args.remote ?? (backend = await startLocalBackend()).url;

  const last = args.continue ? loadLastSession() : undefined;
  const matched = last && last.agent === args.agent ? last : undefined;
  const resume = args.resume ?? matched?.sessionId;
  const taskId = args.task ?? matched?.taskId;

  let isError = false;
  try {
    if (args.direct) {
      const events = runAgentStream(baseUrl, args.agent, {
        prompt: args.print ?? "",
        resume,
        ...(taskId ? { params: { taskId } } : {}),
      });
      for await (const e of events) {
        if (e.event === "text") {
          process.stdout.write(e.data.text as string);
        } else if (e.event === "tool_call") {
          process.stderr.write(`⚙ ${String(e.data.name)}\n`);
        } else if (e.event === "progress") {
          const p = e.data as { title?: unknown; status?: unknown };
          process.stderr.write(`[${String(p.status)}] ${String(p.title)}\n`);
        } else if (e.event === "result") {
          isError = Boolean(e.data.isError);
          const sessionId = e.data.sessionId as string | undefined;
          const rTaskId = e.data.taskId as string | undefined;
          if (sessionId || rTaskId) {
            saveLastSession({ sessionId, taskId: rTaskId, agent: args.agent });
          }
        } else if (e.event === "error") {
          isError = true;
          process.stderr.write(`\nerror: ${String(e.data.message)}\n`);
        }
      }
    } else {
      // boss 模式（完整 boss：任务队列/验收）：wait SSE 承载全部 boss 消息，任务收敛即结束
      const events = runBossWait(baseUrl, {
        prompt: args.print ?? "",
        chatId: CLI_DEFAULT_CHAT_ID,
        senderName: "本地用户",
      });
      for await (const e of events) {
        if (e.event === "boss_message") {
          process.stdout.write(`${String(e.data.text)}\n\n`);
        } else if (e.event === "error") {
          isError = true;
          process.stderr.write(`\nerror: ${String(e.data.message)}\n`);
        }
      }
    }
    process.stdout.write("\n");
  } finally {
    await backend?.close();
  }
  process.exit(isError ? 1 : 0);
}
