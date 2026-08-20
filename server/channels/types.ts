import type { OutboundCard } from "./card.js";

/** 渠道层统一消息模型：各渠道把原始报文规范化为此结构后进入主流程 */
export interface ChannelMessage {
  /**
   * 渠道类型，如 "dingtalk" / "cli"。一种类型只跑一个实例，故它同时就是渠道身份。
   * 会随消息写进 chats / schedules 的 channel 字段，出站投递据此选回哪个渠道。
   */
  channel: string;
  chatType: "private" | "group";
  /** 会话 id：群聊=群会话 id，私聊=发送者 id（用于多轮 session 映射） */
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string;
  /** 渠道附件已下载到本机后的规范化描述；Boss 工具只允许读取这里列出的文件。 */
  attachments?: Array<{
    name: string;
    path: string;
    mimeType?: string;
    size?: number;
  }>;
  /** 渠道原始报文 */
  raw: unknown;
}

/**
 * 回复到消息来源会话。
 * card 是可选的渐进增强：支持的渠道渲染成可点按钮，不支持的渠道忽略它——
 * 因此 text 必须始终自带完整语义。
 */
export type ReplyFn = (text: string, card?: OutboundCard) => Promise<void>;

/**
 * 投递目标：定位「消息发给谁」，与具体渠道实现解耦。
 *
 * 放在渠道层而非 boss/delivery：`Channel.push` 要用它，而 delivery 属于 boss 侧，
 * 类型定义留在那边会让渠道反向依赖 boss。
 */
export interface DeliveryTarget {
  /** 渠道类型，如 "dingtalk" / "cli" */
  channel: string;
  chatId: string;
  chatType: "private" | "group";
  /** 私聊主动推送需要 staffId（钉钉单聊按用户推，chatId 即 staffId） */
  ownerSenderId?: string;
}

/**
 * 渠道抽象：新增渠道类型（飞书/企微/Slack）= 实现本接口 + 在 channels/registry.ts 注册工厂。
 * start 内完成连接建立，收到消息规范化为 ChannelMessage 后调 manager.dispatchToAgent。
 *
 * 一种类型只跑一个实例：员工、知识库、工作台都是服务实例级共享的，同类型多实例（如两个
 * 钉钉企业）等于跨企业共享团队资产。要接第二个企业请起第二个服务实例（换 runtimeDir）。
 */
export interface Channel {
  /** 渠道类型，同时是这个渠道的唯一身份 */
  readonly type: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * 凭据是否齐全。false = 该渠道未配置，`startChannels` 静默跳过。
   *
   * 渠道默认随 foreman 一起启动之后，「没配」是**常态而非错误**：每次进 CLI 都刷一行
   * 「缺少 clientId」纯属噪音。但 `start()` 自己的告警要留着 —— 用户在看板存完密钥走
   * `restartChannel` 时，那条路径上说「还是缺凭据」正是需要大声说的时候。
   *
   * 不实现 = 视为已配置（老渠道无需改动）。
   */
  isConfigured?(): boolean;
  /**
   * 主动推送：不依赖任何会话上下文，可在任意时刻送达（定时任务、数小时后的任务播报）。
   * 返回 false = 当前推不出去（缺凭据等），由投递层继续回落。
   * 不实现 = 该渠道只支持被动回复。
   */
  push?(target: DeliveryTarget, text: string, card?: OutboundCard): Promise<boolean>;
}

/**
 * 系统级主动推送（复盘/优化/定时任务/任务播报）的默认落点渠道类型。
 *
 * 单独抽成常量是为了只有一处写着 "dingtalk"：`boss/delivery` 要同步取它、
 * 又不能静态 import registry（会与 registry → dingtalk/channel → manager → boss 成环），
 * 所以放在这个零依赖的类型模块里当单一事实源。
 *
 * 将来应由「用户身份最近活跃的那个渠道」取代——`retro.notifyChat` / `notifyUser` 配的是
 * 某个渠道里的会话 id / 工号，本质上是「人」的地址，而不该由用户手填渠道。
 */
export const DEFAULT_CHANNEL_TYPE = "dingtalk";

/**
 * 本机 CLI 的缺省会话 id。
 *
 * 两个用途：CLI / headless 发请求时带的 chatId，以及 HTTP 层判断「这是一条真 CLI 请求，
 * 还是后台在某个已有会话里发言」的判据（见 api/http.ts）。
 *
 * 声明了跨渠道身份（core/identity.ts）之后，它会在入站处被换成 principal id，
 * 于是 CLI 与钉钉私聊落进同一个会话上下文；未声明时保持原样。
 */
export const CLI_DEFAULT_CHAT_ID = "cli:local";
