import { type Request, type Response, type Router } from "express";
import {
  LIMITS,
  describeTiming,
  getSchedule,
  listSchedules,
  removeSchedule,
  updateSchedule,
  type Schedule,
} from "../scheduler/schedule-store.js";
import { agentExists, stillRunning } from "../scheduler/scheduler.js";
import { employeeDisplayName } from "../boss/persona.js";
import { listChatMetas, type ChatMeta } from "../core/chat-store.js";

/**
 * 看板的定时任务管理：**全局视图**。
 *
 * 为什么这里刻意不按会话过滤(而主管的 `list_schedules` 必须过滤)：
 * - 主管在群里回话，若全局列出就会把用户私聊的定时任务念给全群听 —— 那是信息泄露，
 *   所以 boss 侧按 `msg.chatId` 隔离是**正确**的，不要「对齐」成全局。
 * - 但按会话隔离之后，用户本人就失去了跨会话的全局视图：一条定时任务落在他已经不再
 *   说话的旧会话里，就变成「看不见、管不了，却每天照推」。2026-08 真实事故即此形态
 *   （钉钉早期把单聊判成群聊 → 同一个人拿到两个 chatId，主管在新会话里一口咬定
 *   「没有这条定时任务」，而它一直活着）。
 * - 看板是内网 + `localhostOnly` 门禁的单人管理界面，不存在群内泄露问题，正是承载
 *   全局视图的地方。**这一层就是为了让「这条在往哪儿推、归谁」一眼可见。**
 *
 * 并发：无 ETag / If-Match，两个标签页同时操作后写胜出。单人内网看板可接受。
 */

function fail(res: Response, error: unknown, status = 400): void {
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

/** 投递目标的异常种类。共性是**静默失效** —— 不报错，只是推错地方或没人看得见 */
export type TargetIssueKind =
  /** chat-store 里没有这个会话的任何记录 */
  | "chat_unknown"
  /** 钉钉私聊却 chatId ≠ ownerSenderId。归一化(normalizePrivateChatIds)本应修掉，留作绊线 */
  | "chat_id_mismatch"
  /** 同一个人名下有多个私聊会话记录 —— 2026-08 事故的直接特征 */
  | "owner_multi_chat"
  /** 目标不是该 owner 最近说话的那个会话 → 主管在用户当前所在的会话里看不见这条 */
  | "boss_blind";

export interface ScheduleTargetIssue {
  kind: TargetIssueKind;
  message: string;
}

export interface ScheduleTarget {
  chatId: string;
  channel: string;
  chatType: "private" | "group";
  /** 人类可读名：meta.title > 发言人聚合 > ownerSenderName > chatId */
  label: string;
  /** chat-store 里有这个会话的记录 */
  known: boolean;
  lastMessageAt?: number;
  messageCount?: number;
  /** 同一 ownerSenderId 名下的其它私聊会话，按最近活跃倒序 */
  siblings: Array<{ chatId: string; lastMessageAt: number; messageCount: number }>;
  issues: ScheduleTargetIssue[];
}

export interface ScheduleEntry {
  id: string;
  title: string;
  prompt: string;
  agentName: string;
  agentLabel: string;
  agentMissing: boolean;
  timingText: string;
  enabled: boolean;
  disabledReason?: string;
  /**
   * `enabled: true` 却仍残留 `disabledReason`。
   * 主管的 resume_schedule 只清 enabled/failCount/backoffUntil，不清这个字段，
   * 于是库里会出现「已启用 + 停用原因: 连续失败 3 次」的自相矛盾状态。
   */
  staleDisabledReason: boolean;
  running: boolean;
  lastTaskId?: string;
  backoffUntil?: number;
  backoffActive: boolean;
  runCount: number;
  skipCount: number;
  failCount: number;
  /** 还差几次连续失败会被自动停用 */
  failuresToAutoDisable: number;
  lastRunAt?: number;
  dependsOn?: string;
  dependsOnLabel?: string;
  /** 前置已不存在。dependencyGate 会按「无依赖」放行(宁可不排序也要跑)，不会永不执行 */
  dependsOnMissing: boolean;
  dependents: Array<{ id: string; title: string }>;
  createdBy: string;
  createdAt: number;
  seedKey?: string;
  /** 内置任务：删掉后下次启动会被 seedBuiltins() 重新播种，正确关法是停用 */
  builtin: boolean;
  ownerSenderId: string;
  ownerSenderName: string;
  target: ScheduleTarget;
}

export interface ScheduleGroup {
  chatId: string;
  label: string;
  channel: string;
  chatType: "private" | "group";
  known: boolean;
  lastMessageAt?: number;
  /** 组内条目的 issue kind 去重，供组头徽章使用 */
  issueKinds: TargetIssueKind[];
  schedules: ScheduleEntry[];
}

export interface SchedulesResp {
  /** 服务端时钟：避免客户端时钟偏差把「退避中」算错 */
  now: number;
  limits: { total: number; perAgent: number; maxConsecutiveFailures: number };
  stats: {
    total: number;
    enabled: number;
    disabled: number;
    running: number;
    backoffActive: number;
    withIssues: number;
    chats: number;
  };
  groups: ScheduleGroup[];
}

export interface ChatIndex {
  byChat: Map<string, ChatMeta>;
  /** ownerSenderId → 该人名下的私聊会话，按最近活跃倒序 */
  byOwner: Map<string, ChatMeta[]>;
}

/** chatId 与「人 → 会话」两个索引。后者是同人多会话/主管盲区判定的基础 */
export function buildChatIndex(metas: ChatMeta[]): ChatIndex {
  const byChat = new Map<string, ChatMeta>();
  const byOwner = new Map<string, ChatMeta[]>();
  for (const m of metas) {
    byChat.set(m.chatId, m);
    if (m.chatType !== "private" || !m.ownerSenderId) continue;
    const list = byOwner.get(m.ownerSenderId);
    if (list) list.push(m);
    else byOwner.set(m.ownerSenderId, [m]);
  }
  for (const list of byOwner.values()) list.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return { byChat, byOwner };
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN");
}

/**
 * 解析投递目标并逐条判定异常。
 * 每条独立 push、不 early-return —— 一条 schedule 可能同时有多个毛病。
 */
export function analyzeTarget(s: Schedule, idx: ChatIndex): ScheduleTarget {
  const meta = idx.byChat.get(s.chatId);
  const issues: ScheduleTargetIssue[] = [];
  const label =
    meta?.title || (meta?.senders.length ? meta.senders.join("、") : "") || s.ownerSenderName || s.chatId;

  if (!meta) {
    issues.push({
      kind: "chat_unknown",
      message: `投递目标 ${s.chatId} 在会话记录里查不到，结果可能推给一个没人在看的会话。`,
    });
  }
  if (
    s.channel === "dingtalk" &&
    s.chatType === "private" &&
    s.ownerSenderId &&
    s.chatId !== s.ownerSenderId
  ) {
    issues.push({
      kind: "chat_id_mismatch",
      message: `钉钉单聊的 chatId 应等于归属人 staffId(${s.ownerSenderId})，实际是 ${s.chatId}。归一化本应自动修正，出现说明有旁路写入。`,
    });
  }

  const owned = s.ownerSenderId ? (idx.byOwner.get(s.ownerSenderId) ?? []) : [];
  const siblings = owned
    .filter((m) => m.chatId !== s.chatId)
    .map((m) => ({ chatId: m.chatId, lastMessageAt: m.lastMessageAt, messageCount: m.messageCount }));
  if (siblings.length > 0) {
    issues.push({
      kind: "owner_multi_chat",
      message: `同一个人(${s.ownerSenderId})名下有 ${siblings.length + 1} 个私聊会话记录，本条只推 ${s.chatId}。`,
    });
  }
  // 主管盲区：用户最近在别处说话 → 他在那边问「有哪些定时任务」时看不见这条
  const newest = owned[0];
  if (newest && newest.chatId !== s.chatId) {
    issues.push({
      kind: "boss_blind",
      message: `用户最近在 ${newest.chatId}(${stamp(newest.lastMessageAt)})说话；主管的 list_schedules 按当前会话过滤，在那边看不见这条。`,
    });
  }

  return {
    chatId: s.chatId,
    channel: s.channel,
    chatType: s.chatType,
    label,
    known: !!meta,
    ...(meta ? { lastMessageAt: meta.lastMessageAt, messageCount: meta.messageCount } : {}),
    siblings,
    issues,
  };
}

/**
 * Schedule → DTO。
 * ⚠️ 必须新建对象：`listSchedules()` 返回的数组虽是浅拷贝，元素却是模块级缓存里的
 * 同一批引用，直接回传会把内部状态暴露给前端、且改动会污染缓存又不落盘。
 */
export function toEntry(
  s: Schedule,
  idx: ChatIndex,
  dependents: Array<{ id: string; title: string }>,
  now: number,
): ScheduleEntry {
  const dep = s.dependsOn ? getSchedule(s.dependsOn) : undefined;
  return {
    id: s.id,
    title: s.title,
    prompt: s.prompt,
    agentName: s.agentName,
    agentLabel: employeeDisplayName(s.agentName),
    agentMissing: !agentExists(s.agentName),
    timingText: describeTiming(s.timing),
    enabled: s.enabled,
    ...(s.disabledReason ? { disabledReason: s.disabledReason } : {}),
    staleDisabledReason: s.enabled && !!s.disabledReason,
    running: stillRunning(s),
    ...(s.lastTaskId ? { lastTaskId: s.lastTaskId } : {}),
    ...(s.backoffUntil ? { backoffUntil: s.backoffUntil } : {}),
    backoffActive: !!s.backoffUntil && s.backoffUntil > now,
    runCount: s.runCount,
    skipCount: s.skipCount,
    failCount: s.failCount,
    failuresToAutoDisable: Math.max(0, LIMITS.maxConsecutiveFailures - s.failCount),
    ...(s.lastRunAt ? { lastRunAt: s.lastRunAt } : {}),
    ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
    ...(dep ? { dependsOnLabel: dep.title } : {}),
    dependsOnMissing: !!s.dependsOn && !dep,
    dependents,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    ...(s.seedKey ? { seedKey: s.seedKey } : {}),
    builtin: !!s.seedKey,
    ownerSenderId: s.ownerSenderId,
    ownerSenderName: s.ownerSenderName,
    target: analyzeTarget(s, idx),
  };
}

/** id → 依赖它的任务。先建一次表，避免逐条 O(n²) 扫描 */
export function buildDependentsMap(all: Schedule[]): Map<string, Array<{ id: string; title: string }>> {
  const map = new Map<string, Array<{ id: string; title: string }>>();
  for (const s of all) {
    if (!s.dependsOn) continue;
    const list = map.get(s.dependsOn);
    const item = { id: s.id, title: s.title };
    if (list) list.push(item);
    else map.set(s.dependsOn, [item]);
  }
  return map;
}

/** 全量 → 按会话分组。异常组置顶：这一页存在的理由就是让异常先被看到 */
export function buildGroups(all: Schedule[], idx: ChatIndex, now: number): ScheduleGroup[] {
  const dependentsMap = buildDependentsMap(all);
  const groups = new Map<string, ScheduleGroup>();
  for (const s of all) {
    const entry = toEntry(s, idx, dependentsMap.get(s.id) ?? [], now);
    let g = groups.get(s.chatId);
    if (!g) {
      const meta = idx.byChat.get(s.chatId);
      g = {
        chatId: s.chatId,
        label: entry.target.label,
        channel: s.channel,
        chatType: s.chatType,
        known: entry.target.known,
        ...(meta ? { lastMessageAt: meta.lastMessageAt } : {}),
        issueKinds: [],
        schedules: [],
      };
      groups.set(s.chatId, g);
    }
    g.schedules.push(entry);
    for (const i of entry.target.issues) {
      if (!g.issueKinds.includes(i.kind)) g.issueKinds.push(i.kind);
    }
  }
  const list = [...groups.values()];
  for (const g of list) {
    // 组内按创建时间：刻意不按 enabled 排序 —— 每次写操作都全量重载，
    // 按状态排会让刚点过的那一行跳走，手感很差
    g.schedules.sort((a, b) => a.createdAt - b.createdAt);
  }
  list.sort(
    (a, b) =>
      b.issueKinds.length - a.issueKinds.length ||
      (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) ||
      a.chatId.localeCompare(b.chatId),
  );
  return list;
}

/**
 * 「启用」的正确口径 —— 与 boss-tools 的 resume_schedule 对齐，并多清一个字段。
 *
 * `failCount` 与 `backoffUntil` 必须同时清：漏掉任一个，恢复后会立刻又被退避挡住
 * (isDue 开头就判 backoff)，表现为「点了启用但它就是不跑」。
 * 额外清 `disabledReason`：不清会留下「已启用 + 停用原因」的矛盾状态。
 * undefined 值靠 JSON.stringify 落盘时丢键实现真删。
 */
export function resumeSchedule(id: string): Schedule | undefined {
  return updateSchedule(id, {
    enabled: true,
    failCount: 0,
    backoffUntil: undefined,
    disabledReason: undefined,
  });
}

export function registerScheduleRoutes(router: Router): void {
  router.get("/schedules", (_req: Request, res: Response) => {
    try {
      const now = Date.now();
      const all = listSchedules();
      const idx = buildChatIndex(listChatMetas());
      const groups = buildGroups(all, idx, now);
      const entries = groups.flatMap((g) => g.schedules);
      res.json({
        now,
        limits: {
          total: LIMITS.total,
          perAgent: LIMITS.perAgent,
          maxConsecutiveFailures: LIMITS.maxConsecutiveFailures,
        },
        stats: {
          total: entries.length,
          enabled: entries.filter((e) => e.enabled).length,
          disabled: entries.filter((e) => !e.enabled).length,
          running: entries.filter((e) => e.running).length,
          backoffActive: entries.filter((e) => e.backoffActive).length,
          withIssues: entries.filter((e) => e.target.issues.length > 0).length,
          chats: groups.length,
        },
        groups,
      } satisfies SchedulesResp);
    } catch (error) {
      fail(res, error, 500);
    }
  });

  router.put("/schedules/:id/enabled", (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const s = getSchedule(id);
      if (!s) return fail(res, new Error(`定时任务 #${id} 不存在`), 404);
      // 只认这一个字段：updateSchedule 是裸 Object.assign 无白名单，
      // 把 body 直传等于把 id / runCount / lastTaskId 开放给前端改
      const enabled = (req.body ?? {}).enabled;
      if (typeof enabled !== "boolean") {
        return fail(res, new Error("body.enabled 必须是布尔值"));
      }
      if (enabled && !agentExists(s.agentName)) {
        // 硬拦不给 force：启用后到点只会被 fireOne 自动停用，并给用户会话推一条告警，
        // 等于凭空制造一次打扰
        return fail(
          res,
          new Error(
            `员工「${s.agentName}」已不存在，启用后到点会被自动停用并给用户发告警。请先恢复该员工。`,
          ),
          409,
        );
      }

      const warnings: string[] = [];
      const updated = enabled
        ? resumeSchedule(id)
        : updateSchedule(id, { enabled: false, disabledReason: "后台手动停用" });
      // 停用刻意不动 failCount：失败历史是排查素材
      if (!enabled && stillRunning(s)) {
        warnings.push(
          `上一实例仍在运行${s.lastTaskId ? `(任务 #${s.lastTaskId})` : ""}，停用只影响下一次触发，不会中断它。`,
        );
      }
      const dependents = buildDependentsMap(listSchedules()).get(id) ?? [];
      if (!enabled && dependents.length > 0) {
        warnings.push(
          `有 ${dependents.length} 条任务依赖它排序，停用后它们按「无依赖」立即跑，排序失效。`,
        );
      }

      const idx = buildChatIndex(listChatMetas());
      res.json({
        ok: true as const,
        schedule: toEntry(updated!, idx, dependents, Date.now()),
        warnings,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/schedules/:id", (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const s = getSchedule(id);
      if (!s) return fail(res, new Error(`定时任务 #${id} 不存在`), 404);

      // 一次收齐所有阻塞项，不遇到第一个就返回 —— 让人一次看清代价。
      // ⚠️ 文案要短:j<T>() 只保留响应体前 300 字，且这段会被塞进 confirm() 弹窗
      const blockers: Array<{ kind: string; message: string }> = [];
      if (stillRunning(s)) {
        blockers.push({
          kind: "running",
          message: `上一实例仍在运行${s.lastTaskId ? `(#${s.lastTaskId})` : ""}，删除后它的终态无人认领。`,
        });
      }
      const dependents = buildDependentsMap(listSchedules()).get(id) ?? [];
      if (dependents.length > 0) {
        const head = dependents
          .slice(0, 3)
          .map((d) => `#${d.id}`)
          .join("、");
        blockers.push({
          kind: "dependents",
          message: `${dependents.length} 条任务依赖它排序(${head}${dependents.length > 3 ? " 等" : ""})，删除后排序失效。`,
        });
      }
      if (s.seedKey) {
        blockers.push({
          kind: "builtin",
          message: "这是内置任务，下次启动会被重新播种。要长期关掉请改用停用。",
        });
      }

      if (blockers.length > 0 && req.query.force !== "1") {
        res.status(409).json({
          error: blockers.map((b) => `· ${b.message}`).join("\n"),
          blockers,
        });
        return;
      }

      // 刻意不级联改依赖方的 dependsOn：dependencyGate 对不存在的前置返回 free
      // (宁可不排序也要跑)，不会静默永不执行；悬挂依赖在 DTO 里以 dependsOnMissing 明示。
      // 少动别人的记录 = 爆炸半径最小。
      removeSchedule(id);
      res.json({ ok: true as const, id, title: s.title });
    } catch (error) {
      fail(res, error);
    }
  });
}
