import { bossRecover, initBossInbox, emitSystemEvent } from "../boss/boss.js";
import { bridgeEventBusToInbox } from "../boss/event-bus.js";
import { startChannels, stopChannels } from "../channels/registry.js";
import { startEnvReload } from "../core/env-reload.js";
import { startScheduler } from "../scheduler/scheduler.js";

/**
 * 「单一大脑」运行时的启动序列。
 *
 * 为什么要单独一份：这段顺序原先在 `api/serve.ts` 与 `cli/repl.tsx` 各写了一遍，而它
 * **不是随便排的**（见下方注释）。两处复制就是这类顺序 bug 的来源 —— 改对一处、忘掉另一处，
 * 症状还只在「入站消息没人消费」这种难复现的场景下出现。
 *
 * 目录单独开一层也是刻意的：本模块依赖 boss / scheduler / channels，放进 `core/` 会反转
 * 依赖方向（core 是被它们依赖的那层）并引入环。只允许两个入口 import 它。
 */

export interface BossRuntimeOptions {
  /**
   * 是否启动渠道。false = 完全不碰（`--no-channels`）。
   * 默认 true，但**未配置凭据的渠道不会启动也不刷警告**（见 registry.startChannels）。
   */
  channels?: boolean;
}

export interface BossRuntimeHandle {
  /** 真正启动了的渠道类型；[] = 没有任何渠道（未配置 / 被禁 / 抢锁失败） */
  startedChannels: string[];
  /** 停调度 + 停渠道。幂等：信号路径与正常退出路径都会调 */
  stop(): Promise<void>;
}

export async function startBossRuntime(
  opts: BossRuntimeOptions = {},
): Promise<BossRuntimeHandle> {
  // 恢复重启前中断的 running 任务（重新派发）。必须在 inbox/bridge 之前：
  // recover 会重放状态变更与播报，桥还没接上时这些事件不该进 inbox。
  // boss 层异常绝不阻断后续启动 —— 起不来渠道比丢几条恢复更糟。
  try {
    bossRecover();
  } catch (error) {
    console.error("[boss] recover 失败（不影响后续启动）:", error);
  }

  // 事件驱动装配：注册 inbox 消费 + 桥接 event-bus 终态事件。
  // 必须在 startChannels 之前 —— 一条入站钉钉消息会直接进 dispatchToAgent，
  // 此时没有 inbox 消费者的话，主管收不到这条消息。
  initBossInbox();
  bridgeEventBusToInbox(emitSystemEvent);

  // 热重载 .env 鉴权信息：代理 token 轮换后无需重启（修复反复 401）
  startEnvReload();

  // 定时任务调度（含每日复盘）。第二个进程拿不到 scheduler 锁会优雅跳过，不是错误。
  const stopScheduler = await startScheduler();

  const startedChannels = opts.channels === false ? [] : await startChannels();

  let stopped = false;
  return {
    startedChannels,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      stopScheduler();
      await stopChannels();
    },
  };
}
