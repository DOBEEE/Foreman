import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import {
  getAgent,
  getBuiltinAgentIds,
  listAgents,
  listRoutableAgents,
  listTempAgents,
} from "../agents/registry.js";
import {
  hiredProfileExists,
  hiredProfilePath,
  saveHiredProfile,
  type AgentProfile,
} from "../config/agent-profile.js";
import { config } from "../config/index.js";
import { buildToolCatalog } from "../tools/catalog.js";
import { loadBossPersona } from "../boss/persona.js";
import { taskManager as tm } from "../boss/task-manager.js";
import { taskTitle } from "../boss/task-label.js";
import { releaseTempWorker } from "../boss/temp-worker.js";
import { getLiveEvents, subscribe, type BusEvent } from "../boss/event-bus.js";
import type { Task } from "../boss/types.js";
import { LOG_DIR, type TraceEvent, type TraceRecord } from "../core/logger.js";
import { collectCacheStats } from "../core/cache-stats.js";
import { listChatMetas, loadChatMessages, setChatTitle } from "../core/chat-store.js";
import { readBossDecisions } from "../core/boss-log.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerTeamBundleRoutes } from "./team-bundle-routes.js";
import { registerScheduleRoutes } from "./schedule-routes.js";

/** 把 ::ffff:1.2.3.4 这类 v4-mapped-v6 归一成 IPv4 点分十进制；非 IPv4 返回 undefined */
function toIPv4(raw: string): string | undefined {
  const ip = raw.replace(/^::ffff:/i, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : undefined;
}

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/**
 * 客户端是否与本机处于同一网段：用物理网卡的 netmask 做按位比较。
 * 比「是否 RFC1918 私网段」更准 —— 公司内网常用 30.x 这类非私网段地址。
 */
function isSameSubnet(clientIp: string): boolean {
  const VIRTUAL = /^(utun|tun|tap|ppp|awdl|llw|bridge|vmnet|vnic|docker|veth|wg|zt)/i;
  const client = ipToInt(clientIp);
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal || !ni.netmask) continue;
      const mask = ipToInt(ni.netmask);
      if ((client & mask) === (ipToInt(ni.address) & mask)) return true;
    }
  }
  return false;
}

/**
 * Dashboard 访问守卫。dashboard 能改配置 + 看所有 chat 原文，所以分三档放行：
 * DASHBOARD_TOKEN 命中 > 本机回环 > 同网段客户端（config.dashboardAccess="lan"，默认）。
 * 跨网段/公网访问必须配 DASHBOARD_TOKEN。
 */
export function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.DASHBOARD_TOKEN;
  if (token) {
    const provided =
      (req.headers["x-dashboard-token"] as string | undefined) ||
      (req.query.token as string | undefined);
    if (provided === token) return next();
  }
  const raw = req.socket.remoteAddress ?? "";
  // v4 loopback / v6 loopback / v4-mapped-v6 loopback
  if (raw === "127.0.0.1" || raw === "::1" || raw === "::ffff:127.0.0.1") return next();
  const ip = toIPv4(raw);
  if (config.dashboardAccess === "lan" && ip && isSameSubnet(ip)) return next();
  res.status(403).json({
    error:
      config.dashboardAccess === "lan"
        ? "dashboard 仅限本机与同网段访问；跨网段访问请设置 DASHBOARD_TOKEN"
        : "dashboard 仅限本机访问；如需远程访问设置 DASHBOARD_TOKEN 或把 dashboardAccess 改为 lan",
  });
}

/** 把一个 agent 序列化为 UI 友好的元数据（声明项直接来自它的 profile） */
function serializeAgent(agent: ReturnType<typeof getAgent>) {
  if (!agent) return undefined;
  const p = agent.profile;
  return {
    id: agent.name,
    name: p.displayName ?? agent.name,
    avatar: p.avatar,
    description: agent.description,
    routeHint: p.routeHint,
    type: p.type ?? "builtin",
    /**
     * 归属分组：exec=内置岗位（总裁办，随代码发布、不可删）/ staff=用户员工（预置播种 + 招聘）
     */
    group: p.source === "hired" ? ("staff" as const) : ("exec" as const),
    /**
     * 只有招聘员工可在 dashboard 编辑；内置岗位配置在 server/config/agents/ 里改。
     * 临时工也不可编辑——他会自动释放，改他没有意义；要留下来得走建岗提案。
     */
    configurable: p.source === "hired" && !p.temp,
    manualOnly: agent.manualOnly,
    tools: p.tools,
    mcpServers: p.mcpServers,
    model: p.model,
    maxTurns: p.maxTurns,
    maxThinkingTokens: p.maxThinkingTokens,
    workspacePolicy: p.workspacePolicy,
    maxParallel: p.maxParallel,
    steps: p.steps,
    retro: p.retro,
    /** 临时工元信息：UI 用它渲染虚线卡片与剩余存活时间 */
    ...(p.temp
      ? {
          temp: {
            capability: p.temp.capability,
            hiredFor: p.temp.hiredFor,
            hiredBy: p.temp.hiredBy,
            taskId: p.temp.taskId,
            lastUsedAt: p.temp.lastUsedAt,
            /** 到点即释放（TTL 锚在 lastUsedAt，还在被用的人会一直续） */
            expiresAt: p.temp.lastUsedAt + config.tempWorker.ttlHours * 3600 * 1000,
          },
        }
      : {}),
    createdAt: p.createdAt,
    createdBy: p.createdBy,
  };
}

/**
 * 组织图：节点（boss + 员工 + 在岗临时工）+ 边（boss→员工分发 + SOP 组长→委派员工）。
 *
 * 临时工进这里是安全的：**展示 ≠ 路由**。路由候选走 listRoutableAgents()，
 * 那里永远排除临时工；这里只是渲染，看不见反而会让 Sessions 里退化成裸 id + 默认头像。
 */
function buildTeamGraph() {
  const agents = listAgents()
    .map((a) => getAgent(a.name))
    .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => Boolean(a));
  const temps = listTempAgents();
  const routable = new Set(listRoutableAgents().map((a) => a.name));
  const persona = loadBossPersona();

  const nodes = [
    {
      id: "__boss__",
      kind: "boss" as const,
      name: persona.name,
      avatar: persona.avatar,
      description: persona.role,
    },
    ...agents.map((a) => ({ kind: "agent" as const, ...serializeAgent(a)! })),
    ...temps.map((a) => ({ kind: "temp" as const, ...serializeAgent(a)! })),
  ];

  const edges: Array<{
    id: string;
    from: string;
    to: string;
    kind: "dispatch" | "delegate";
    stepId?: string;
    accept?: boolean;
    manual?: boolean;
    temp?: boolean;
  }> = [];

  // boss → 所有员工（含手动触发型，UI 用 manual 标记区分样式）
  for (const a of agents) {
    edges.push({
      id: `dispatch:${a.name}`,
      from: "__boss__",
      to: a.name,
      kind: "dispatch",
      ...(routable.has(a.name) ? {} : { manual: true }),
    });
  }
  // boss → 临时工：虚线，且**只对绑定任务成立**（不是常设的分发关系）
  for (const a of temps) {
    edges.push({ id: `dispatch:${a.name}`, from: "__boss__", to: a.name, kind: "dispatch", temp: true });
  }

  // SOP 组长 → 委派下属
  for (const a of agents) {
    if (a.profile.type !== "sop") continue;
    for (const step of a.profile.steps ?? []) {
      if (step.mode === "delegate" && step.delegate) {
        edges.push({
          id: `delegate:${a.name}:${step.id}`,
          from: a.name,
          to: step.delegate,
          kind: "delegate",
          stepId: step.id,
          accept: Boolean(step.accept),
        });
      }
    }
  }

  return { nodes, edges };
}

/** 活跃编队：lead 的断点状态文件（<用户目录>/squads/<taskId>.json） */
function listSquads(): Array<Record<string, unknown>> {
  const dir = join(config.runtimeDir, "squads");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const file of files) {
    try {
      const state = JSON.parse(readFileSync(join(dir, file), "utf-8")) as Record<string, unknown>;
      out.push({ taskId: file.replace(/\.json$/, ""), ...state });
    } catch {
      /* skip 坏文件 */
    }
  }
  return out;
}

/** 单个 chat 的汇总元数据 */
function chatSummary(chatId: string) {
  const tasks = tm.allTasks().filter((t) => t.chatId === chatId);
  const active = tasks.filter(
    (t) => !["done", "failed", "cancelled"].includes(t.state),
  );
  const waiting = tasks.filter((t) => t.state === "waiting_user");
  const last = tasks.reduce(
    (max, t) => (t.updatedAt > max ? t.updatedAt : max),
    0,
  );
  const senders = new Set<string>();
  for (const t of tasks) senders.add(t.ownerSenderName || t.ownerSenderId);
  const anyTask = tasks[0];
  return {
    chatId,
    channel: anyTask?.channel,
    chatType: anyTask?.chatType,
    taskCount: tasks.length,
    activeCount: active.length,
    waitingCount: waiting.length,
    senders: [...senders],
    lastActivity: last,
  };
}

/** 扫今日+昨日 traces 文件，按 params.taskId 过滤后取事件列表回放 */
/** 回放窗口：trace 按天分片，往前扫这么多天（老任务点开也要能看到历史，不能只看今天） */
const REPLAY_LOOKBACK_DAYS = 30;

function replayTraceEvents(taskId: string): TraceEvent[] {
  const now = Date.now();
  const files = Array.from(
    { length: REPLAY_LOOKBACK_DAYS },
    (_, i) =>
      `${LOG_DIR}traces-${new Date(now - i * 86400_000).toISOString().slice(0, 10)}.jsonl`,
  ).reverse(); // 由旧到新，保证事件时序
  const events: TraceEvent[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      // 简化版：一次读入文件全文（trace 文件按天分片，通常几 MB 以内）
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as TraceRecord;
          if ((rec.params as { taskId?: string } | undefined)?.taskId !== taskId)
            continue;
          for (const ev of rec.events ?? []) events.push(ev);
        } catch {
          /* skip 坏行 */
        }
      }
    } catch {
      /* skip 读失败 */
    }
  }
  // 按 seq 排序，跨 run 的 seq 会重置，靠先 file 顺序 + 内部 seq 保序即可
  return events;
}

export function createConsoleRouter(): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));
  router.use(localhostOnly);
  registerSettingsRoutes(router);
  registerTeamBundleRoutes(router);
  registerScheduleRoutes(router);

  // ─── 组织 ────────────────────────────────────────────
  router.get("/team", (_req, res) => {
    res.json(buildTeamGraph());
  });

  // 编队（SOP 流转）：plan + 各步执行/评审记录
  router.get("/squads", (_req, res) => {
    res.json({ squads: listSquads() });
  });

  router.get("/squads/:taskId", (req, res) => {
    const id = req.params.taskId.replace(/[^\w-]/g, "_");
    const squad = listSquads().find((s) => s.taskId === id);
    if (!squad) return res.status(404).json({ error: "squad not found" });
    res.json({ squad });
  });

  /**
   * Token 用量与 prompt cache 命中（按 agent / 按任务两个维度）。
   * 缓存失效是**静默**的（不报错、只是变贵），这个接口是唯一能看见回归的地方——
   * 真实事故：换运行时后命中率从 87% 掉到 1.5% 无人察觉。
   */
  router.get("/cache-stats", (req, res) => {
    const raw = Number(req.query.days);
    const days = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 60) : 7;
    const stats = collectCacheStats(days);
    // 任务标题只能在这一层 join：core/cache-stats 不能反向依赖 boss。
    // 用 taskTitle() 而不是自造，口径与渠道播报里的 #id「名字」保持一致
    const titles = new Map(tm.allTasks().map((t) => [t.id, taskTitle(t, 40)]));
    res.json({
      ...stats,
      tasks: stats.tasks.map((t) => ({ ...t, label: titles.get(t.key) || t.key })),
    });
  });

  router.get("/tool-catalog", (_req, res) => {
    res.json(buildToolCatalog());
  });

  router.get("/agents/:id", (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "unknown agent" });
    const meta = serializeAgent(agent)!;
    // 内置岗位只回元数据（配置在 server/config/agents/ 里改）；招聘员工回完整可编辑配置
    res.json({ ...meta, config: meta.configurable ? agent.profile : null });
  });

  router.post("/agents", (req, res) => {
    const cfg = req.body as AgentProfile;
    try {
      if (getBuiltinAgentIds().includes(cfg?.id))
        return res.status(400).json({ error: `id 与内置岗位冲突：${cfg.id}` });
      if (hiredProfileExists(cfg?.id))
        return res.status(409).json({ error: `员工 ${cfg.id} 已存在，若要修改请用 PUT` });
      saveHiredProfile({
        ...cfg,
        createdAt: cfg.createdAt ?? new Date().toISOString(),
        createdBy: cfg.createdBy ?? "dashboard",
      });
      res.json({ ok: true, id: cfg.id });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.put("/agents/:id", (req, res) => {
    const id = req.params.id;
    const cfg = req.body as AgentProfile;
    if (id !== cfg?.id) return res.status(400).json({ error: "URL id 与 body.id 不一致" });
    if (getBuiltinAgentIds().includes(id))
      return res.status(400).json({ error: "内置岗位不可通过 dashboard 修改（改 server/config/agents/<id>.json）" });
    if (getAgent(id)?.profile.temp)
      return res.status(400).json({ error: "临时工不可编辑：他会自动释放，要长期留下请走建岗提案" });
    if (!hiredProfileExists(id))
      return res.status(404).json({ error: "员工不存在" });
    try {
      saveHiredProfile(cfg);
      res.json({ ok: true, id });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.delete("/agents/:id", (req, res) => {
    const id = req.params.id;
    if (getBuiltinAgentIds().includes(id))
      return res.status(400).json({ error: "内置岗位不可删除" });
    const path = hiredProfilePath(id);
    if (!existsSync(path)) return res.status(404).json({ error: "员工不存在" });
    // 拦截：有活跃任务派给该员工时先取消/等结束再删
    const busy = tm.allActiveTasks().filter((t) => t.agentName === id);
    if (busy.length > 0) {
      return res.status(409).json({
        error: `该员工有 ${busy.length} 个活跃任务，先取消或等结束再删`,
        activeTaskIds: busy.map((t) => t.id),
      });
    }
    try {
      // 临时工必须走释放收口：裸 unlink 会永久销毁他的 systemPrompt（归纳建岗要用），
      // 还会把工作目录与经验库目录留成垃圾
      if (getAgent(id)?.profile.temp) releaseTempWorker(id);
      else unlinkSync(path);
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ─── 会话 / 任务 ───────────────────────────────────
  /**
   * 会话列表 = 任务派生的 chat ∪ chat-store 里的 chat。
   * 必须并集：tm.allChatIds() 只认识「有过任务」的会话（扫 boss/*.json 取 tasks[0].chatId），
   * 纯闲聊的钉钉群一条任务都没派过，只靠它会整个消失。
   */
  router.get("/chats", (req, res) => {
    const state = (req.query.state as string | undefined) ?? "all";
    const metas = new Map(listChatMetas().map((m) => [m.chatId, m]));
    const ids = new Set([...tm.allChatIds(), ...metas.keys()]);
    let chats = [...ids].map((chatId) => {
      const summary = chatSummary(chatId);
      const meta = metas.get(chatId);
      return {
        ...summary,
        // chatType/channel 以 chat-store 的 meta 为准，而不是任务派生值：
        // task 里存的是「创建那一刻」的快照，会话类型判定修正后这些历史快照仍是旧值；
        // meta 由每条消息实时维护，是消息层的权威。
        channel: meta?.channel ?? summary.channel,
        chatType: meta?.chatType ?? summary.chatType,
        ...(meta?.title ? { title: meta.title } : {}),
        ...(meta ? { lastText: meta.lastText, messageCount: meta.messageCount } : {}),
        senders: summary.senders.length > 0 ? summary.senders : (meta?.senders ?? []),
        lastActivity: Math.max(summary.lastActivity, meta?.lastMessageAt ?? 0),
      };
    });
    if (state === "active") chats = chats.filter((c) => c.activeCount > 0);
    chats.sort((a, b) => b.lastActivity - a.lastActivity);
    res.json({ chats });
  });

  /** 会话历史消息：后台对话页切换会话时加载 */
  router.get("/chats/:chatId/messages", (req, res) => {
    const raw = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(raw) && raw > 0 ? raw : 200;
    const chatId = req.params.chatId;
    res.json({ chatId, messages: loadChatMessages(chatId, limit) });
  });

  /** 给会话起个人类可读的名字（钉钉开放平台不提供群名） */
  router.put("/chats/:chatId/title", (req, res) => {
    const { title } = (req.body ?? {}) as { title?: unknown };
    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title (non-empty string) is required" });
    }
    const ok = setChatTitle(req.params.chatId, title.trim());
    if (!ok) return res.status(404).json({ error: "chat not found" });
    res.json({ ok: true });
  });

  router.get("/chats/:chatId/tasks", (req, res) => {
    const chatId = req.params.chatId;
    const tasks: Task[] = tm.allTasks().filter((t) => t.chatId === chatId);
    tasks.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ chatId, tasks });
  });

  /**
   * 会话维度的主管决策流。
   * 分诊（派给谁）与直答发生在任务创建之前，没有 taskId 可挂，
   * 只能在这里看——「主管为什么把这活儿给了他」的答案在这条流里。
   */
  router.get("/chats/:chatId/boss-log", (req, res) => {
    const raw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(raw) && raw > 0 ? raw : 100;
    const decisions = readBossDecisions({ chatId: req.params.chatId, limit });
    res.json({ chatId: req.params.chatId, decisions });
  });

  router.get("/tasks/:id", (req, res) => {
    const id = req.params.id;
    const task = tm.allTasks().find((t) => t.id === id);
    if (!task) return res.status(404).json({ error: "task not found" });
    res.json({ task });
  });

  router.get("/tasks/:id/stream", (req, res) => {
    const taskId = req.params.id;
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

    // 1) 回放历史：已收尾的轮次来自 traces 日志；正在跑的那一轮日志还没落盘，
    //    从事件总线的内存缓冲补上，否则运行中打开页面会看不到之前的执行过程
    const replayed = replayTraceEvents(taskId);
    const live = getLiveEvents(taskId);
    send("replay_begin", { count: replayed.length + live.length });
    for (const ev of replayed) send("trace", ev);
    for (const ev of live) send("agent_event", ev);
    // 主管针对这条任务的判断（代答裁决 / 验收）：员工 trace 之外的另一半事实
    for (const d of readBossDecisions({ taskId })) send("boss_decision", d);
    send("replay_end", {});

    // 2) 挂事件总线，实时转发
    const unsub = subscribe(
      (e: BusEvent) => {
        if (e.kind === "task.agent_event") send("agent_event", e.event);
        else if (e.kind === "boss.decision") {
          // 分诊/路由发生在任务创建之前（decision.taskId 为空），不属于这条任务的时间线
          if (e.decision.taskId === taskId) send("boss_decision", e.decision);
        } else if (e.kind === "task.state_change")
          send("state_change", { from: e.from, to: e.to, task: e.task });
        else if (e.kind === "task.created") send("created", e.task);
      },
      { taskId },
    );

    req.on("close", () => {
      clearInterval(heartbeat);
      unsub();
      if (!res.writableEnded) res.end();
    });
  });

  return router;
}

export const hiredAgentsDir = config.hiredAgentsDir;
