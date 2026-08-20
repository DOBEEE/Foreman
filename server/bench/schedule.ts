import { config } from "../config/index.js";
import { deliver, notifyTarget } from "../boss/delivery.js";
import { pendingApprovalsBrief } from "./approval.js";
import { runBenchCycle, summarizeCycle, type BenchCycleResult } from "./cycle.js";

/**
 * 一层回归的周期触发。
 *
 * 为什么不走 schedule-store 的定时任务：那套是**给 agent 派活**的（agentName + prompt →
 * 起一个会话），而这里要跑的是确定性代码，没有 agent 可派、也不该消耗一次 LLM 会话
 * 去触发一件零 LLM 的事。所以用最朴素的自己的定时器。
 *
 * 补跑策略是「同一天只跑一次」而不是「错过就算了」：进程重启很常见，
 * 而回归报告是优化师的输入，缺一周就等于优化师那周瞎了。
 */

const CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** 上次跑完的日期（YYYY-MM-DD），进程内记忆即可——重启后重跑一次是可接受的代价 */
let lastRunDay: string | undefined;

function dueNow(now: Date): boolean {
  const day = now.toISOString().slice(0, 10);
  if (lastRunDay === day) return false;
  if (now.getDay() !== config.bench.weekday) return false;
  // 到点或已过点都跑（进程在 20:00 之后才起来时能补上）
  return now.getHours() >= config.bench.hour;
}

async function tick(): Promise<void> {
  const now = new Date();
  if (!dueNow(now)) return;
  lastRunDay = now.toISOString().slice(0, 10);
  try {
    const result = await runBenchCycle({ days: config.bench.days });
    if (!result.ok) {
      console.warn(`[bench] ${result.message}`);
      // 没拿到锁不算跑过：把标记退回去，下个检查窗口再试
      lastRunDay = undefined;
      return;
    }
    console.log(`[bench] 一层回归完成：${summarizeCycle(result.value!)}`);
    await notifyIfNeeded(result.value!);
  } catch (error) {
    console.warn("[bench] 一层回归失败：", error);
  }
}

/**
 * 只在**有事要人处理**时推送。
 *
 * 「本周全绿」不通知：定期收到一条无需动作的消息，人很快就不看了，
 * 等真的有待审标准时那条也一起被忽略。
 */
async function notifyIfNeeded(result: BenchCycleResult): Promise<void> {
  const failed = result.reports.filter((item) => item.report.summary.failed > 0);
  const brief = pendingApprovalsBrief();
  if (!failed.length && !brief) return;

  const parts: string[] = ["🧪 一层回归（零 LLM 断言）"];
  for (const item of failed) {
    const s = item.report.summary;
    parts.push(
      `\n**${item.agentId}**：${s.failed}/${s.total} 个 case 失败 —— 之前修过的问题又犯了。` +
        `\n报告：\`${item.markdownFile}\``,
    );
  }
  // 待审用例放在后面：它需要人当场决策，而失败只是知情
  if (brief) parts.push(`\n${brief}`);
  await deliver(notifyTarget(), parts.join("\n"));
}

/** 启动周期触发；返回停止函数。config.bench.schedule 为 false 时不启动 */
export function startBenchSchedule(): () => void {
  if (!config.bench.schedule) return () => {};
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref?.();
  void tick();
  console.log(
    `[bench] 一层回归已排期：每周${config.bench.weekday} ${String(config.bench.hour).padStart(2, "0")}:00，` +
      `回看 ${config.bench.days} 天采集 case`,
  );
  return () => clearInterval(timer);
}
