import { DingTalkChannel } from "./dingtalk/channel.js";
import type { Channel } from "./types.js";

/**
 * 渠道注册表。
 *
 * 新增渠道类型（飞书/企微/Slack）= 实现 Channel 接口 + 在 FACTORIES 里加一行。
 * 出站投递不需要跟着改：boss/delivery 按 target.channel 查表调 `Channel.push`。
 *
 * 一种类型只跑一个实例，所以「类型」就是「身份」——要接第二个钉钉企业请起第二个服务实例
 * （换 runtimeDir）；员工/知识库/工作台都是服务实例级共享的，同进程混两个企业等于泄漏。
 */
const FACTORIES: Record<string, () => Channel> = {
  dingtalk: () => new DingTalkChannel(),
};

/** 已构造的渠道：type → 实例。懒构造，getChannel / startChannels 都会触发。 */
const channels = new Map<string, Channel>();

function ensureChannels(): Channel[] {
  if (channels.size === 0) {
    for (const [type, make] of Object.entries(FACTORIES)) channels.set(type, make());
  }
  return [...channels.values()];
}

/**
 * 取渠道实例（未构造则先构造）。
 *
 * 刻意做成懒构造而非依赖 startChannels：headless / 定时任务进程可能根本不建长连接，
 * 但仍要能主动推送——推送走 HTTP API，跟连接无关。
 */
export function getChannel(type: string): Channel | undefined {
  ensureChannels();
  return channels.get(type);
}

/**
 * 启动全部**已配置**的渠道：单个失败不阻塞其他渠道与 HTTP 服务。
 *
 * 未配置的渠道静默跳过 —— 渠道默认随 foreman 启动后，「没配钉钉」是绝大多数本地会话的
 * 常态，每次都刷一行缺凭据警告纯属噪音（`start()` 里的那条告警留给 restartChannel）。
 *
 * @returns 实际尝试启动且没抛错的渠道类型；调用方据此决定提示什么
 */
export async function startChannels(): Promise<string[]> {
  const started: string[] = [];
  for (const channel of ensureChannels()) {
    if (channel.isConfigured?.() === false) continue;
    try {
      await channel.start();
      started.push(channel.type);
    } catch (error) {
      console.error(`[channel:${channel.type}] 启动失败:`, error);
    }
  }
  return started;
}

export async function stopChannels(): Promise<void> {
  await Promise.allSettled([...channels.values()].map((c) => c.stop()));
}

/**
 * 重启单个渠道：stop 再 start，让运行期改的凭据（如 web 里换了钉钉 AppKey/AppSecret）
 * 生效——收消息的长连接是启动期建的，不吃 process.env 热更，只能重连。
 * 旧连接靠 channel 内的 acquireLock(takeover) 接管，不会与新连接抢消息。
 */
export async function restartChannel(type: string): Promise<void> {
  const channel = getChannel(type);
  if (!channel) throw new Error(`未知渠道：${type}`);
  await channel.stop();
  await channel.start();
}
