/**
 * 渠道层校验（零 LLM，纯断言）。
 *
 * 守的是「一种渠道类型一个实例」这条不变式，以及投递层与具体渠道的解耦：
 * 1. registry 懒构造 + 同类型恒返回同一实例（凭据缓存、单实例锁都依赖这点）
 * 2. Channel 暴露 type 而非 name，且 dingtalk 实现了 push
 * 3. delivery 不再硬编码钉钉：未知渠道 push 返回 false，投递层继续回落
 * 4. notifyTarget 的落点回落链：群 → 单聊 → cli
 *
 * 用法：npx tsx server/channels/__fixtures__/check-channels.ts
 */

import { getChannel, restartChannel } from "../registry.js";
import { DEFAULT_CHANNEL_TYPE } from "../types.js";
import { pushToChannel, notifyTarget } from "../../boss/delivery.js";

/**
 * 清掉钉钉凭据：`resolveDingTalkCreds` 会兜底读 process.env，而开发者本机 .env 里通常配着
 * 真凭据——不清的话这个夹具会真的去调钉钉接口（实测发出过一次 groupMessages/send）。
 * 凭据在调用时才读，所以在这里删就够，不必抢在 import 之前。
 */
delete process.env.DINGTALK_CLIENT_ID;
delete process.env.DINGTALK_CLIENT_SECRET;
delete process.env.DINGTALK_ROBOT_CODE;

let pass = 0;
const fails: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    process.stdout.write(`  \u2705 ${label}\n`);
  } else {
    fails.push(label);
    process.stdout.write(`  \u274C ${label}${detail ? ` — ${detail}` : ""}\n`);
  }
}

async function main(): Promise<void> {
  process.stdout.write("\n▶ registry\n");
  const dingtalk = getChannel("dingtalk");
  check("dingtalk 渠道已注册", dingtalk !== undefined);
  check("渠道以 type 为身份（不再是 name）", dingtalk?.type === "dingtalk");
  check("dingtalk 实现了主动推送", typeof dingtalk?.push === "function");
  // 同一实例：凭据缓存与单实例锁都挂在实例上，每次 new 会重复抢锁
  check("同类型重复取回同一实例", getChannel("dingtalk") === dingtalk);
  check("未知渠道类型返回 undefined", getChannel("feishu") === undefined);

  let restartError: string | undefined;
  try {
    await restartChannel("feishu");
  } catch (e) {
    restartError = e instanceof Error ? e.message : String(e);
  }
  check("重启未知渠道会报错", Boolean(restartError?.includes("未知渠道")));

  process.stdout.write("\n▶ 投递层解耦\n");
  check("DEFAULT_CHANNEL_TYPE 由渠道层单一提供", DEFAULT_CHANNEL_TYPE === "dingtalk");
  // 没有注册的渠道不能让投递链抛错，只能回落（活跃会话 → 推送 → 仅落日志）
  const unknown = await pushToChannel(
    { channel: "feishu", chatId: "c1", chatType: "group" },
    "hi",
  );
  check("未注册渠道 pushToChannel 返回 false（不抛错）", unknown === false);

  // 钉钉未配凭据时也必须是 false 而不是抛错——夹具环境没有 AppKey
  const noCreds = await pushToChannel(
    { channel: "dingtalk", chatId: "c1", chatType: "group" },
    "hi",
  );
  check("缺凭据时钉钉推送返回 false", noCreds === false);

  process.stdout.write("\n▶ notifyTarget 回落链\n");
  const { config } = await import("../../config/index.js");
  const retro = config.retro as { notifyChat: string; notifyUser: string };
  const originalChat = retro.notifyChat;
  const originalUser = retro.notifyUser;

  retro.notifyChat = "cid_group";
  retro.notifyUser = "";
  let t = notifyTarget();
  check(
    "配了群 → 群聊落点走默认渠道",
    t.channel === DEFAULT_CHANNEL_TYPE && t.chatId === "cid_group" && t.chatType === "group",
    JSON.stringify(t),
  );

  retro.notifyChat = "";
  retro.notifyUser = "1001,1002";
  t = notifyTarget();
  check(
    "只配了人 → 取第一个工号做单聊落点",
    t.channel === DEFAULT_CHANNEL_TYPE &&
      t.chatId === "1001" &&
      t.chatType === "private" &&
      t.ownerSenderId === "1001",
    JSON.stringify(t),
  );

  retro.notifyChat = "";
  retro.notifyUser = "";
  t = notifyTarget();
  check(
    "都没配 → 回落 cli 会话",
    t.channel === "cli" && t.chatId === "cli:local",
    JSON.stringify(t),
  );

  retro.notifyChat = originalChat;
  retro.notifyUser = originalUser;

  report();
}

function report(): void {
  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

main();
