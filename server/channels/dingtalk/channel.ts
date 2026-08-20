import { DWClient, TOPIC_ROBOT, type RobotMessage } from "dingtalk-stream";
import { config } from "../../config/index.js";
import { dispatchToAgent } from "../manager.js";
import { acquireLock, releaseLock } from "../lock.js";
import { downloadInboundImage, downloadInboundTeamFile, processLocalImages } from "./media.js";
import { previewTitle, toDingTalkMarkdown } from "./markdown.js";
import { dtmdReplyUrl, type OutboundCard } from "../card.js";
import { appendMessageLog } from "../../core/logger.js";
import { resolvePrivateChatId } from "../../core/identity.js";
import { resolveDingTalkCreds, type DingTalkCreds } from "./creds.js";
import type { Channel, ChannelMessage, DeliveryTarget } from "../types.js";
import { dingtalkPush } from "./push.js";

/** 感知延迟兜底话术：boss 还在决策时先冒个泡 */
const ACK_TEXT = "👌 收到，正在看…";

/**
 * 钉钉机器人渠道（Stream 模式）：WebSocket 长连接收消息，无需公网回调 URL。
 * 接收私聊消息与群聊 @ 消息；回复走消息自带的 sessionWebhook。
 * 凭证：DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET（AppKey / AppSecret）。
 * 单实例锁：同一 clientId 全局只允许一个进程监听，避免多进程瓜分连接抢消息。
 */
export class DingTalkChannel implements Channel {
  readonly type = "dingtalk";
  private client?: DWClient;
  private lockKey?: string;
  /**
   * 本次连接用的凭据。收消息期间的下载/上传都用它，而不是每次重新解析——
   * 一条消息的处理链路必须与建立连接时是同一份凭据，中途被后台改掉不该串。
   */
  private creds?: DingTalkCreds;

  /**
   * 凭据是否齐全。与 `start()` 用同一个解析函数 —— 凭据可能来自看板的 credential store，
   * 不只是环境变量，两处口径不一致会出现「说没配、其实配了」。
   */
  isConfigured(): boolean {
    return resolveDingTalkCreds() !== undefined;
  }

  async start(): Promise<void> {
    const creds = resolveDingTalkCreds();
    if (!creds) {
      console.warn(
        "[dingtalk] 缺少 clientId / clientSecret（去 Dashboard → 设置 → 渠道 配置，或填 .env），跳过启动",
      );
      return;
    }
    const { clientId, clientSecret } = creds;

    // 重入守卫：restartChannel 场景下先拆掉上一条连接与锁，避免旧 WebSocket 悬着 / 双重持锁
    if (this.client) await this.stop();

    // 单实例锁：同一 token（clientId）已有活进程监听则接管
    // （kill 旧进程再抢锁，避免旧进程持着过期凭证还在连接、导致 401 / 消息漂到旧实例）
    const lockKey = `dingtalk:${clientId}`;
    if (!(await acquireLock(lockKey, { takeover: true }))) {
      console.warn(
        `[dingtalk] 该 token（clientId=${clientId.slice(0, 6)}…）已被另一进程持有且无法接管，` +
          "本进程跳过钉钉渠道。如需同机再起一个钉钉服务，请换用不同的 DINGTALK_CLIENT_ID。",
      );
      return;
    }
    this.lockKey = lockKey;
    this.creds = creds;

    // keepAlive 必开：dingtalk-stream 默认 keepAlive:false，不启动 ping/pong 心跳。
    // 而它的 autoReconnect 只在 socket 触发 close 时排期——TCP 静默断开（网络抖动 / NAT
    // 空闲超时 / 休眠）会让连接"半开"：readyState 仍是 OPEN、close 永不触发，于是入站
    // 永久沉默却不重连（出站 push 走独立 HTTP，照常，故障极隐蔽）。心跳漏 pong 会
    // terminate socket → 触发 close → autoReconnect 接管，正是补上这张安全网。
    this.client = new DWClient({ clientId, clientSecret, keepAlive: true });
    this.client.registerCallbackListener(TOPIC_ROBOT, (res) => {
      // 先 ack，避免 agent 执行期间钉钉 60s 重推
      this.client?.socketCallBackResponse(res.headers.messageId, {
        response: "success",
      });
      void this.handleMessage(res.data);
    });
    await this.connectWithRetry();
    console.log("[dingtalk] stream connected");
  }

  /** 主动推送：与长连接无关，凭据齐全即可用（抢不到锁也照样能推） */
  async push(target: DeliveryTarget, text: string, card?: OutboundCard): Promise<boolean> {
    return dingtalkPush(target, text, card);
  }

  /**
   * 首次连接失败若疑似"上一个会话还没被服务端清理"（401/expired），指数退避重试。
   * 常见触发场景：本进程刚接管过前一个持锁进程，钉钉服务端尚未意识到旧 WebSocket 已断。
   */
  private async connectWithRetry(): Promise<void> {
    const delays = [0, 3000, 6000]; // 首次立即，随后 3s、6s
    let lastError: unknown;
    for (const [i, delay] of delays.entries()) {
      if (delay > 0) {
        console.warn(
          `[dingtalk] 连接失败疑似上游会话未清理，等待 ${delay / 1000}s 后重试（第 ${i + 1}/${delays.length - 1} 次）…`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        await this.client!.connect();
        return;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        // 只对"401 / invalid access token / expired / token"这类鉴权面错重试；
        // 凭证真错（重试也没救）与鉴权面暂态无法完全区分，用有限次数+日志兜住
        if (!/401|invalid.*(access|token)|expired/i.test(msg)) throw error;
        if (i === delays.length - 1) break;
      }
    }
    throw lastError;
  }

  private async handleMessage(rawData: string): Promise<void> {
    let data: RobotMessage;
    try {
      data = JSON.parse(rawData) as RobotMessage;
    } catch {
      console.warn("[dingtalk] 无法解析的消息报文，已忽略");
      return;
    }

    const reply = (text: string, card?: OutboundCard) =>
      this.reply(data.sessionWebhook, text, card);

    // 会话类型：钉钉官方语义是 conversationType "1"=单聊、"2"=群聊。
    // 早先这里（连注释）判反了：单聊被当成群聊（回复走群接口 → 400）、
    // 群聊被当成单聊（chatId 取发言人 staffId → 同群不同人被拆成多个会话、
    // boss 的回复私聊推给发言人而不是发回群里）。
    // 注意单聊也会下发 conversationId，不能靠「有没有 conversationId」判断。
    const isPrivate = data.conversationType === "1";
    // 单聊用 staffId：主动推送是按人推（oToMessages/batchSend），且与定时任务的配置一致。
    // 再过一层身份归一，让同一个人从 CLI / 将来的飞书企微进来落在同一个会话上下文；
    // 没声明 principal 时它恒等返回 staffId，行为与归一前一致。群聊不归一（群里有别人）。
    const chatId = isPrivate
      ? resolvePrivateChatId(this.type, data.senderStaffId, data.senderStaffId)
      : data.conversationId;

    // 解析正文 + 附带的图片（picture / richText 富文本图文混排）
    const parsed = await this.extractContent(data, chatId);
    if (!parsed) {
      await reply("暂不支持该消息类型，请发送文本或图片");
      return;
    }

    // @ 门控：钉钉企业机器人（Stream）在群里仅推送 @ 了本机器人的消息，
    // 门控由平台保证；单聊全量下发。故此处无需额外拦截。
    const msg: ChannelMessage = {
      channel: this.type,
      chatType: isPrivate ? "private" : "group",
      chatId,
      senderId: data.senderStaffId,
      senderName: data.senderNick,
      text: parsed.text,
      ...(parsed.attachments?.length ? { attachments: parsed.attachments } : {}),
      raw: data,
    };
    if (!msg.text) return;

    // 智能 ack：钉钉无公开的「消息表情回应」API（只能发消息），
    // 所以用一句轻量「收到」兜住感知延迟——但仅当 boss 在阈值内还没开始回话时才发，
    // 快路径（命中确定性分支、无 LLM 分类）不会双发刷屏。
    // replied 在 trackedReply 入口即置位（不含发送网络耗时），所以阈值只需覆盖
    // 「boss 同步决策」的时间；走 LLM 分类必然超时，ack 一定会发。
    // DINGTALK_ACK=off 关闭；DINGTALK_ACK_DELAY_MS 调阈值。
    let replied = false;
    const trackedReply = async (text: string, card?: OutboundCard): Promise<void> => {
      replied = true;
      await reply(text, card);
    };
    let ackTimer: NodeJS.Timeout | undefined;
    if (config.dingtalk.ack) {
      const delay = config.dingtalk.ackDelayMs;
      ackTimer = setTimeout(() => {
        if (replied) return;
        // ack 也记账：否则消息日志里看不到它，线上「有没有发出去」无从查证
        console.log(`[dingtalk] boss ${delay}ms 未回话，先发 ack（chat=${chatId}）`);
        appendMessageLog({
          time: new Date().toISOString(),
          direction: "out",
          channel: this.type,
          chatType: msg.chatType,
          chatId,
          text: ACK_TEXT,
        });
        void reply(ACK_TEXT);
      }, delay);
    }

    try {
      await dispatchToAgent(msg, trackedReply);
    } finally {
      if (ackTimer) clearTimeout(ackTimer);
    }
  }

  /**
   * 解析钉钉消息为「正文 + 本地图片路径」。返回 undefined = 不支持的类型。
   * - text：纯文本
   * - picture：content.downloadCode → 下载到本地
   * - richText：图文混排，逐项取 text 与 downloadCode
   * 图片以本地绝对路径追加进正文，agent 可用 Read 工具直接看图。
   */
  private async extractContent(
    data: RobotMessage,
    chatId: string,
  ): Promise<{ text: string; attachments?: NonNullable<ChannelMessage["attachments"]> } | undefined> {
    const raw = data as unknown as Record<string, any>;
    const msgtype = String(raw.msgtype ?? "");
    let body = "";
    const codes: string[] = [];

    if (msgtype === "text") {
      body = String(raw.text?.content ?? "").trim();
    } else if (msgtype === "picture") {
      const c = raw.content ?? raw.picture ?? {};
      if (c.downloadCode) codes.push(String(c.downloadCode));
      body = "";
    } else if (msgtype === "richText") {
      const items: any[] = raw.content?.richText ?? raw.richText?.richTextList ?? [];
      const texts: string[] = [];
      for (const it of items) {
        if (it?.text) texts.push(String(it.text));
        if (it?.downloadCode) codes.push(String(it.downloadCode));
      }
      body = texts.join("").trim();
    } else if (msgtype === "file") {
      const content = raw.content ?? raw.file ?? {};
      if (!content.downloadCode) return undefined;
      const creds = this.activeCreds();
      const attachment = creds
        ? await downloadInboundTeamFile(
            creds,
            String(content.downloadCode),
            chatId,
            String(content.fileName ?? content.name ?? "team.ait-team"),
          )
        : undefined;
      if (!attachment) {
        return { text: "（用户上传了文件，但它不是合法大小的 .ait-team 团队包或下载失败）" };
      }
      return {
        text: `（用户上传了团队配置文件：${attachment.name}，请先检查内容，不要直接覆盖）`,
        attachments: [attachment],
      };
    } else {
      return undefined;
    }

    if (codes.length === 0) return body ? { text: body } : undefined;

    // 下载图片（失败的跳过，不阻断消息）
    const creds = this.activeCreds();
    const paths: string[] = [];
    for (const code of codes) {
      const p = creds ? await downloadInboundImage(creds, code, chatId) : undefined;
      if (p) paths.push(p);
    }
    if (paths.length === 0) {
      return { text: body || "（用户发来一张图片，但下载失败，请让用户改用文字描述）" };
    }

    const note = [
      body || "（用户只发了图片，没有文字说明）",
      "",
      `[用户附带了 ${paths.length} 张图片，已保存在本地。**先用 Read 工具读取这些图片**再回答：]`,
      ...paths.map((p) => `- ${p}`),
    ].join("\n");
    return { text: note };
  }

  /**
   * 当前可用凭据：优先用建立连接时那份，保证一条消息的处理链路前后一致；
   * 未启动（如只做主动推送）时临时解析。
   */
  private activeCreds(): DingTalkCreds | undefined {
    return this.creds ?? resolveDingTalkCreds();
  }

  private async reply(
    sessionWebhook: string,
    text: string,
    card?: OutboundCard,
  ): Promise<void> {
    const creds = this.activeCreds();
    // 本地截图（playwright 验证图等）自动上传换成 media_id，否则钉钉里显示不出来。
    // 缺凭据时原样发出：图显示不出来，但消息不能丢。
    const withImages = creds ? await processLocalImages(creds, text) : text;
    const markdownText = toDingTalkMarkdown(withImages);

    const post = async (payload: Record<string, unknown>): Promise<void> => {
      const res = await fetch(sessionWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`sessionWebhook 返回 ${res.status}`);
    };

    // 卡片优先：按钮点击 = 代用户发出对应文本，走原入站管道
    if (card) {
      try {
        await post({
          msgtype: "actionCard",
          actionCard: {
            title: card.title,
            text: toDingTalkMarkdown(
              creds ? await processLocalImages(creds, card.text) : card.text,
            ),
            btnOrientation: "0", // 竖排：选项文字通常较长，横排会被截断
            btns: card.actions.map((a) => ({
              title: a.title,
              actionURL: dtmdReplyUrl(a.reply),
            })),
          },
        });
        return;
      } catch (error) {
        // 卡片渲染失败不能吞掉问题本身：回落 markdown（text 自带完整选项清单）
        console.warn("[dingtalk] actionCard 发送失败，回落 markdown:", error);
      }
    }

    try {
      await post({
        msgtype: "markdown",
        markdown: { title: previewTitle(text), text: markdownText },
      });
    } catch (error) {
      console.warn("[dingtalk] markdown 回复失败，回落纯文本:", error);
      try {
        await post({ msgtype: "text", text: { content: text } });
      } catch (fallbackError) {
        console.error("[dingtalk] 回复失败:", fallbackError);
      }
    }
  }

  async stop(): Promise<void> {
    this.client?.disconnect();
    this.client = undefined;
    this.creds = undefined;
    if (this.lockKey) {
      releaseLock(this.lockKey);
      this.lockKey = undefined;
    }
  }
}
