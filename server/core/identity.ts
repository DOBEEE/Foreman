import { config } from "../config/index.js";

/**
 * 跨渠道身份归一：让同一个人从钉钉 / CLI /（将来）飞书企微 找 boss 时，落在**同一个会话上下文**。
 *
 * 为什么这是「私聊」独有的：
 * - 私聊 = 一个自然人。对用户来说 boss 是同一个助手，session、任务、脑爆摘要都该连着。
 * - 群聊 = 一个组织场域。群里有别人、有别人的发言，跨渠道合并就是信息泄漏。**群永不归一。**
 *
 * 实现方式是在**入站归一处**改写 chatId，而不是在下游引入第二个分片键：
 * `chatId` 是全代码库的分片键（session / 任务 / inbox / 预算 / 工作台 / 脑爆摘要），
 * 加一个并行的 contextKey 要改几百处，还会长期存在「两个键谁是真的」的歧义。
 *
 * ## principal id 为什么沿用主渠道的原生 id
 *
 * 钉钉私聊的 chatId 今天**就是** senderStaffId（见 dingtalk/channel.ts 的取值），所以只要把
 * principal id 声明成那个 staffId，归一后钉钉侧 chatId 纹丝不动——全部历史会话、任务、
 * schedule、脑爆摘要原地继续命中，零迁移。`schedule-store.normalizePrivateChatIds`
 * （把私聊 chatId 归到 ownerSenderId）也因此保持 no-op。
 *
 * ## 投递为什么不用改
 *
 * Task / Schedule 各自已存了发起时的完整地址（channel + chatId + chatType + ownerSenderId，
 * 见 boss.ts 的 `say()`），所以任务播报天然回发起渠道；而 `delivery.activeReply` 按 chatId 索引，
 * 于是「你此刻在哪个渠道说话，回复就落在那里」。这两层加起来已经是想要的语义，无需地址簿。
 *
 * ## 现在只做配置声明
 *
 * 没有可靠的自动跨平台身份识别（手机号/邮箱经常拿不到或不一致，还要通讯录权限），
 * 所以身份必须显式声明。绑定码流程（A 渠道要码、B 渠道输码）留到真的接第二个 IM 时再做，
 * 那时才需要落盘的动态绑定表；现在提前建等于造一个没人用的机制。
 */

export interface ChannelBinding {
  /** 渠道类型，如 "dingtalk" / "cli" */
  channel: string;
  /** 该渠道内这个人的 id：钉钉 = senderStaffId，CLI = "local" */
  senderId: string;
}

export interface Principal {
  /**
   * 归一后的会话 id。**强烈建议**填主渠道（通常是钉钉）的私聊原生 id，
   * 这样存量数据零迁移；填别的值会让该渠道的历史会话被孤立。
   */
  id: string;
  label?: string;
  bindings: ChannelBinding[];
}

export type IdentityMode = "single-user" | "off";

/**
 * 归一开关。
 *
 * `off` 时本模块完全透明（恒等返回），用于多租户：CLI 绑到某个 principal 等于
 * 「谁能碰到这台机器的 shell，谁就拿到那个人的全部会话与任务」。自托管单用户没问题，
 * `serve` 多租户绝不行。默认值按入口定（见 server/index.ts，与 MEMORY 同一套做法）。
 */
export function identityMode(): IdentityMode {
  const raw = (config.identity.mode || process.env.IDENTITY_MODE || "").trim();
  return raw === "single-user" ? "single-user" : "off";
}

/**
 * 生效的 principal 列表（已去掉非法项）。
 *
 * 校验只告警不静默丢弃整份配置：身份配置写错的后果是「两个人的会话混在一起」，
 * 必须让人在日志里看得见，而不是安静地不生效。
 */
export function listPrincipals(): Principal[] {
  if (identityMode() === "off") return [];
  const raw = config.identity.principals;
  if (!Array.isArray(raw)) return [];

  const out: Principal[] = [];
  /** `channel:senderId` → 已占用它的 principal id，用于查重 */
  const claimed = new Map<string, string>();

  for (const [i, item] of raw.entries()) {
    const id = (item?.id ?? "").trim();
    if (!id) {
      console.warn(`[identity] 第 ${i + 1} 个 principal 缺少 id，已跳过`);
      continue;
    }
    const bindings: ChannelBinding[] = [];
    for (const b of item?.bindings ?? []) {
      const channel = (b?.channel ?? "").trim();
      const senderId = (b?.senderId ?? "").trim();
      if (!channel || !senderId) {
        console.warn(`[identity] principal「${id}」有一条 binding 缺 channel 或 senderId，已跳过`);
        continue;
      }
      const key = `${channel}:${senderId}`;
      const owner = claimed.get(key);
      if (owner) {
        // 同一个渠道身份指向两个 principal = 会话会串，且事后极难拆
        console.warn(
          `[identity] ${key} 同时绑给了「${owner}」和「${id}」，只保留前者。` +
            "请修配置——绑错会把两个人的会话与任务混在一起。",
        );
        continue;
      }
      claimed.set(key, id);
      bindings.push({ channel, senderId });
    }
    if (bindings.length === 0) {
      console.warn(`[identity] principal「${id}」没有可用 binding，已跳过`);
      continue;
    }
    // id 应当等于某条 binding 的 senderId（即某个渠道的原生私聊 id），否则该渠道历史会话被孤立
    if (!bindings.some((b) => b.senderId === id)) {
      console.warn(
        `[identity] principal「${id}」的 id 不等于任何 binding 的 senderId。` +
          "这会让原本用该 id 分片的历史会话被孤立，建议把 id 改成主渠道的私聊原生 id。",
      );
    }
    out.push({ id, ...(item?.label ? { label: item.label } : {}), bindings });
  }
  return out;
}

/** 某个渠道身份属于哪个 principal；未声明返回 undefined */
export function principalOf(channel: string, senderId: string): Principal | undefined {
  return listPrincipals().find((p) =>
    p.bindings.some((b) => b.channel === channel && b.senderId === senderId),
  );
}

/**
 * 把「某渠道的私聊」解析成归一后的 chatId。
 *
 * 未声明身份时**返回 nativeChatId 原样**，与归一前的行为完全一致——这个函数可以无条件接在
 * 所有渠道的私聊入站处，不配置就等于没启用。
 *
 * `nativeChatId` 必须显式传、且不给默认值：它与 `senderId` **不总是相等**。钉钉私聊两者都是
 * staffId，但 CLI 的 senderId 是 `local` 而原生 chatId 是 `cli:local`；用 senderId 兜底会把
 * 没配身份的用户悄悄搬到另一个 chatId 上，孤立他全部历史会话与任务。
 *
 * 只接私聊。群聊的 chatId 是会话 id 而不是人的 id，不能进这里。
 */
export function resolvePrivateChatId(
  channel: string,
  senderId: string,
  nativeChatId: string,
): string {
  return principalOf(channel, senderId)?.id ?? nativeChatId;
}
