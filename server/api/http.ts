import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { config } from "../config/index.js";
import { join } from "node:path";
import {
  DEFAULT_AGENT_NAME,
  getAgent,
  listAgents,
  listRoutableAgents,
} from "../agents/registry.js";
import { dispatchToAgent } from "../channels/manager.js";
import { taskManager as tm } from "../boss/task-manager.js";
import { subscribe as subscribeBus } from "../boss/event-bus.js";
import { pushBossMessage, subscribeBossPush } from "./boss-push.js";
import { loadChat } from "../core/chat-store.js";
import { resolvePrivateChatId } from "../core/identity.js";
import { CLI_DEFAULT_CHAT_ID } from "../channels/types.js";
import { pushToChannel } from "../boss/delivery.js";
import type { BaseAgent } from "../agents/base-agent.js";
import { routeAgent } from "../core/router.js";
import { listCommands, resolveCommandPrompt } from "../core/playbooks.js";
import { collectRun, type RunInput } from "../core/runner.js";
import { createConsoleRouter } from "./dashboard.js";
import { createBenchRouter } from "./bench.js";

interface RunBody {
  prompt?: unknown;
  maxTurns?: number;
  /** 临时覆盖 agent 默认响应模式：true=SSE，false=一次性 JSON */
  stream?: boolean;
  /** 业务入参，供 agent 动态拼接系统提示词 */
  params?: Record<string, unknown>;
  /** 多轮会话：resume 上一轮 result 返回的 sessionId */
  resume?: string;
  /** 置 true 使 result 消息带 sessionId 供下轮 resume */
  persistSession?: boolean;
}

/** 路由调用时注入的信息：命中方式 + 路由器提取的入参（请求体 params 优先） */
interface RouteInfo {
  via: string;
  routerParams: Record<string, unknown>;
}

function buildAbort(req: Request, res: Response): AbortController {
  const abortController = new AbortController();
  // 客户端断连时中止 agent，避免空转烧 token。
  // 注意监听 res 而非 req：req 的 close 在请求体读完后就会触发（Node 16+），
  // 而 res 的 close 若发生在响应正常结束前（writableEnded=false）才是真实断连。
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });
  return abortController;
}

/** SSE 流式响应 */
async function handleSse(
  agent: BaseAgent,
  input: RunInput,
  res: Response,
  routeVia?: string,
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  send("agent", { name: agent.name, ...(routeVia ? { via: routeVia } : {}) });

  try {
    for await (const e of agent.run(input)) {
      send(e.event, e.data);
    }
    send("done", {});
  } catch (error) {
    send("error", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

/** 一次性 JSON 响应：收集全部事件后聚合返回 */
async function handleSync(
  agent: BaseAgent,
  input: RunInput,
  res: Response,
  routeVia?: string,
) {
  try {
    const { text, toolCalls, summary } = await collectRun(agent.run(input));
    res.json({
      agent: agent.name,
      ...(routeVia ? { via: routeVia } : {}),
      text,
      toolCalls,
      ...summary,
    });
  } catch (error) {
    res.status(500).json({
      agent: agent.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * HTTP 输入，SSE 或 JSON 输出
 * POST /api/agents/:name/run  { prompt, maxTurns?, stream?, params? }
 * 响应模式：agent.stream 声明默认值，请求体 stream 字段可临时覆盖
 */
async function handleRun(
  agent: BaseAgent,
  req: Request,
  res: Response,
  routeInfo?: RouteInfo,
) {
  const { prompt, maxTurns, stream, params, resume, persistSession } =
    (req.body ?? {}) as RunBody;
  if (typeof prompt !== "string" || !prompt.trim()) {
    res.status(400).json({ error: "prompt (non-empty string) is required" });
    return;
  }

  const input: RunInput = {
    prompt: resolveCommandPrompt(prompt),
    maxTurns,
    // 请求体显式 params 优先，其次用路由器提取的入参
    params: params ?? routeInfo?.routerParams,
    ...(typeof resume === "string" && resume ? { resume } : {}),
    ...(persistSession ? { persistSession: true } : {}),
    abortController: buildAbort(req, res),
  };
  const useStream = typeof stream === "boolean" ? stream : agent.stream;

  if (useStream) {
    await handleSse(agent, input, res, routeInfo?.via);
  } else {
    await handleSync(agent, input, res, routeInfo?.via);
  }
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Benchmark 通道：仅在设置了 BENCH_TOKEN 时注册（能指定任意 cwd，默认关闭）
  const bench = createBenchRouter();
  if (bench) {
    app.use("/api/bench", bench);
    console.log("[bench] /api/bench 已启用（Bearer token + 仅回环）");
  }

  // agent 清单
  app.get("/api/agents", (_req, res) => {
    res.json({ agents: listAgents() });
  });

  // playbook command 清单（CLI 补全 / 菜单数据源）
  app.get("/api/commands", (_req, res) => {
    res.json({ commands: listCommands() });
  });

  // 指定 agent 运行
  app.post("/api/agents/:name/run", (req, res) => {
    const agent = getAgent(req.params.name);
    if (!agent) {
      res.status(404).json({
        error: `unknown agent "${req.params.name}"`,
        available: listAgents(),
      });
      return;
    }
    void handleRun(agent, req, res);
  });

  // 路由运行：LLM 路由器从 http 渠道候选 agent 中选择 + 提取入参
  app.post("/api/route/run", (req, res) => {
    void (async () => {
      const { prompt } = (req.body ?? {}) as RunBody;
      if (typeof prompt !== "string" || !prompt.trim()) {
        res.status(400).json({ error: "prompt (non-empty string) is required" });
        return;
      }
      const candidates = listRoutableAgents();
      if (candidates.length === 0) {
        res.status(503).json({ error: '没有可路由的 agent（channels 需包含 "http" 或 "*"）' });
        return;
      }
      const route = await routeAgent(prompt, candidates);
      if (route.via === "none") {
        res.status(422).json({
          error: `没有职责覆盖这件活的 agent：${route.reason}。请改用 /api/agents/<name>/run 指定执行者，或用 /api/run 走通用编码 agent`,
        });
        return;
      }
      const { agent, params, via } = route;
      console.log(`[router] http -> ${agent.name} (via ${via})`, params);
      await handleRun(agent, req, res, {
        via,
        routerParams: { channel: "http", ...params },
      });
    })().catch((error) => {
      if (!res.headersSent) {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });

  // 兼容简写：等价于 /api/agents/default/run
  app.post("/api/run", (req, res) => {
    void handleRun(getAgent(DEFAULT_AGENT_NAME)!, req, res);
  });

  // boss 常驻消息流（CLI 渠道的「推送通道」，与钉钉 webhook 同构）：
  // boss 的全部出站消息（ack/进度/待确认问题/验收汇报）以 boss_message 事件推送
  app.get("/api/boss/events", (req, res) => {
    const chatId =
      typeof req.query.chatId === "string" && req.query.chatId
        ? req.query.chatId
        : "cli:local";
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const unsubscribe = subscribeBossPush(chatId, res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // boss 对话（CLI 默认走这里）：与钉钉同一套完整 boss（任务队列/等待确认/验收汇报）。
  // 默认（REPL）：立即返回 JSON，boss 回复经 /api/boss/events 推送；
  // wait=true（headless -p）：SSE 挂住，直到本 chat 没有 running/queued 任务才结束。
  app.post("/api/boss/run", (req, res) => {
    const { prompt, chatId, senderId, senderName, wait } = (req.body ?? {}) as {
      prompt?: unknown;
      chatId?: unknown;
      senderId?: unknown;
      senderName?: unknown;
      wait?: unknown;
    };
    if (typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ error: "prompt (non-empty string) is required" });
      return;
    }
    /**
     * 「真 CLI 请求」与「后台在某个已有会话里发言」要分开判。
     *
     * 后者是刻意支持的：后台对话页可以直接在**钉钉会话**里发言，此时 boss 的任务归属、
     * 后台任务播报都必须落到钉钉渠道上，所以渠道按 chatId 反查而不能硬编码 cli。
     *
     * 前者不能走反查：私聊 chatId 归一之后，本机 CLI 的 chatId 会等于钉钉私聊的 chatId，
     * 反查会把 CLI 发言判成 dingtalk 渠道，于是每次本地调试都往用户手机上推一份。
     * 「此刻在哪个渠道说话，回复就落在那里」才是归一想要的语义。
     */
    const rawChatId = typeof chatId === "string" && chatId ? chatId : "";
    const isCliRequest = !rawChatId || rawChatId === CLI_DEFAULT_CHAT_ID;
    const sender = typeof senderId === "string" && senderId ? senderId : "local";
    const cid = isCliRequest
      ? resolvePrivateChatId("cli", sender, CLI_DEFAULT_CHAT_ID)
      : rawChatId;
    const known = isCliRequest ? undefined : loadChat(cid)?.meta;
    const channel = isCliRequest ? "cli" : (known?.channel ?? "cli");
    const chatType = isCliRequest ? "private" : (known?.chatType ?? "private");
    const msg = {
      channel,
      chatType,
      chatId: cid,
      senderId: sender,
      senderName:
        typeof senderName === "string" && senderName ? senderName : "本地用户",
      text: resolveCommandPrompt(prompt),
      raw: req.body,
    };

    if (wait !== true) {
      // REPL 模式：回复走常驻推送流；在钉钉会话里发言时还要同时推回钉钉，
      // 否则群里的人只看得见后台发的问题、看不见 boss 的回答。
      void dispatchToAgent(msg, async (text, card) => {
        pushBossMessage(cid, text);
        if (channel !== "cli") {
          // 推送失败必须降级：钉钉机器人没配好会 400，但那不该让后台也收不到回复
          try {
            await pushToChannel(
              {
                channel,
                chatId: cid,
                chatType,
                // 单聊按人推；存量单聊会话的 chatId 是 conversationId，只能靠这个 staffId
                ...(known?.ownerSenderId ? { ownerSenderId: known.ownerSenderId } : {}),
              },
              text,
              card,
            );
          } catch (error) {
            console.warn(
              `[boss/run] 回推 ${channel} 失败（后台仍可见）:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      });
      res.json({ ok: true, chatId: cid });
      return;
    }

    // headless 模式：本次 SSE 直接承载 boss 消息，直到任务收敛（done/failed/waiting_user）
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      unsubscribeBus();
      send("done", {});
      res.end();
    };
    const busy = () =>
      tm.activeTasks(cid).some((t) => t.state === "running" || t.state === "queued");
    /**
     * 延迟收尾：状态变更事件的发布早于 boss 的收尾消息（markDone → publish → say），
     * 立即 end 会丢掉验收汇报。留一个宽限窗口把尾部消息写完；期间若又有任务跑起来则取消。
     */
    const scheduleFinish = () => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        if (busy()) return;
        finish();
      }, 1500);
    };
    const unsubscribeBus = subscribeBus((e) => {
      if ("chatId" in e && e.chatId !== cid) return;
      if (e.kind !== "task.state_change") return;
      if (busy()) {
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = undefined;
        return;
      }
      scheduleFinish();
    });
    res.on("close", () => {
      settled = true;
      clearInterval(heartbeat);
      if (graceTimer) clearTimeout(graceTimer);
      unsubscribeBus();
    });
    void dispatchToAgent(msg, async (text) => send("boss_message", { text })).then(
      () => {
        // 分发完成后若没有派生出运行中的任务（纯直答/看板类），收尾
        if (!busy()) scheduleFinish();
      },
    );
  });

  // Dashboard 数据面 API（仅 localhost 或 DASHBOARD_TOKEN）
  app.use("/api/console", createConsoleRouter());

  // Dashboard 前端静态资源：web/dist 构建产物
  const webDist = join(config.serviceRoot, "web", "dist");
  if (existsSync(webDist)) {
    app.use("/dashboard", express.static(webDist));
    // SPA 回退：/dashboard/* 都返回 index.html（前端自己路由）
    app.get(/^\/dashboard\/.*/, (_req, res) => {
      res.sendFile(join(webDist, "index.html"));
    });
  } else {
    app.get(/^\/dashboard(\/.*)?$/, (_req, res) => {
      res.status(503).send(
        "<h3>Dashboard 未构建</h3><p>先在项目根跑 <code>npm run build:web</code>，或开发模式跑 <code>npm run dev:web</code>（Vite 会自己起 :5173）。</p>",
      );
    });
  }

  return app;
}
