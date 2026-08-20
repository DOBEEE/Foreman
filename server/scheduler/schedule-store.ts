import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config/index.js";

/**
 * 定时任务（Schedule）：到点后由调度器派发给指定员工，执行走 boss 主干
 * （任务队列 / 并发闸门 / 验收 / Dashboard / 可取消），本模块只负责「表」的持久化与校验。
 */

/** 触发方式（零依赖，够覆盖日常场景；不引 cron 解析） */
export type ScheduleTiming =
  /** 一次性：到 atMs 触发后自动删除 */
  | { kind: "once"; atMs: number }
  /** 每天 HH:MM（本地时区） */
  | { kind: "daily"; hour: number; minute: number }
  /** 每周 weekday（0=周日）的 HH:MM（本地时区） */
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  /** 固定间隔（毫秒，最小 60s） */
  | { kind: "interval"; everyMs: number };

export interface Schedule {
  id: string;
  /** 一句话描述（列表展示用） */
  title: string;
  /** 派给谁（agent 路由名） */
  agentName: string;
  /** 任务内容（等价于用户消息原文） */
  prompt: string;
  /** 主管派工简报（可选，与 prompt 一并下发） */
  brief?: string;
  timing: ScheduleTiming;
  /** 结果投递目标（创建时所在会话） */
  channel: string;
  chatId: string;
  chatType: "private" | "group";
  ownerSenderId: string;
  ownerSenderName: string;
  /** 创建者："boss" 或员工路由名（员工只能建 once，防自我调度增殖） */
  createdBy: string;
  /** 完成后串一个后继任务（线性 then；多步编排请用 SOP 员工） */
  then?: { agentName: string; prompt: string };
  /**
   * 前置 schedule id：本轮必须等它跑完（到终态）才启动，用于「同一时间、一前一后」。
   * 与 then 的区别：then 是上游把下游拽起来（下游频率被迫等于上游），dependsOn 是下游
   * 自己按点触发、只是排在上游后面——两者频率可以不同（如每日复盘 → 每周优化）。
   * 指向的 schedule 不存在时按「无依赖」处理：宁可不排序也要跑，别静默永不执行。
   */
  dependsOn?: string;
  /**
   * 已到点但在等前置完成：存住本轮的触发键，等前置到终态后用它补发。
   * 必须持久化：等待会跨进程重启。也不能靠 isDue 反复判定——daily/weekly 的触发窗口
   * 只有 LIMITS.fireWindowMs（10 分钟），而复盘实测跑 35 分钟，干等会被判成「错过、不补跑」。
   */
  awaitingDep?: { key: string; since: number };
  enabled: boolean;
  /** 停用原因（如员工已不存在） */
  disabledReason?: string;
  lastRunAt?: number;
  /** 上次触发的去重键（daily/weekly 用日期键，防同窗口重复触发） */
  lastRunKey?: string;
  lastTaskId?: string;
  /**
   * 已记过账的任务 id：终态归因的幂等键。
   * 归因允许按 lastTaskId 反查（否则重启后在途任务的终态无人认领），代价是同一个任务的
   * 多次终态事件（返工后再次失败、重启后事件重放）会被重复计数、后继任务被重复派发。
   */
  lastAccountedTaskId?: string;
  runCount: number;
  /** 上一实例未结束而被跳过的次数（可观测：频繁跳过说明周期设太密） */
  skipCount: number;
  /** 连续失败次数：达到阈值自动停用，避免坏任务永久刷屏 */
  failCount: number;
  /** 退避到此时间之前不再触发（连续失败后阶梯退避） */
  backoffUntil?: number;
  /** 内置任务标记（如每日复盘）：用于启动时幂等 seed，避免重复创建 */
  seedKey?: string;
  createdAt: number;
}

/** 数量与频率上限：防止 LLM 失控地无限创建 */
export const LIMITS = {
  total: 50,
  perAgent: 10,
  minIntervalMs: 60_000,
  /** 到点后多久内仍算「该跑」；超过视为错过，不补跑 */
  fireWindowMs: 10 * 60_000,
  /** 连续失败达到此次数即自动停用（避免坏任务每天刷屏） */
  maxConsecutiveFailures: 3,
  /** 失败退避阶梯（毫秒）：按连续失败次数取，超出用最后一档 */
  backoffLadder: [5 * 60_000, 30 * 60_000, 60 * 60_000],
  /**
   * 等前置 schedule（dependsOn）的最长时长，超时放弃本轮并通知。
   * 不能无限等：前置被停用 / 卡死时会退化成「静默永不执行」。
   * 4 小时——复盘实测 35 分钟，留足余量又不会跨到第二天的触发窗口。
   */
  depWaitMs: 4 * 3600_000,
  /**
   * 整点错峰上限：daily/weekly 常被集中设成 9:00 / 21:00，同时触发会一起抢并发闸门。
   * 按 schedule id 派生一个稳定的 0~jitterMaxMs 偏移，把它们摊开。
   */
  jitterMaxMs: 5 * 60_000,
} as const;

const file = join(config.runtimeDir, "schedules.json");
let cache: Schedule[] | undefined;

/**
 * 钉钉私聊 chatId 归一化：钉钉单聊的 chatId 恒等于 ownerSenderId（= senderStaffId）。
 *
 * 为什么需要：钉钉渠道早先把「单聊/群聊」判反了，单聊的 chatId 取成了 conversationId
 * （见 channels/dingtalk/channel.ts 的 isPrivate 注释）。判反期间建的 schedule 至今仍带着
 * 那个作废的 conversationId，于是同一个人被拆成两个 chatId：
 * - 用户在新 chatId 里说话，`list_schedules` 按 msg.chatId 过滤 → 看不见老 schedule，
 *   主管会一口咬定「没有这条定时任务」（真实事故：Top10 速报被误报为已取消）；
 * - 而定时照旧触发，结果推去那个用户已经收不到的老会话，且每次触发都把老 bucket 重建一次
 *   （8/07 手工合并过任务库，但没改 schedule 的 chatId，于是三天后又长回来了）。
 *
 * 放在 load() 是因为它是唯一读入口：一次归一、就地持久化，所有读路径自动受益。
 *
 * 两条收窄都是必需的：
 * - **只动 private**：群聊的 chatId 本就该是 conversationId，误改会把群消息推错地方。
 * - **只动 dingtalk**：这条不变式来自钉钉渠道的 chatId 取值规则，不是全局真理。
 *   cli / bench 的私聊 chatId 是刻意起的名字（`cli_local`、测试夹具的 `CHAT`），
 *   而 ownerSenderId 是 `local` / `tester`——不加渠道判断会把它们一并改写，破坏夹具与 CLI 会话。
 */
function normalizePrivateChatIds(list: Schedule[]): boolean {
  let changed = false;
  for (const s of list) {
    if (s.channel !== "dingtalk") continue;
    if (s.chatType !== "private" || !s.ownerSenderId) continue;
    if (s.chatId === s.ownerSenderId) continue;
    console.warn(
      `[schedule] 修正私聊 chatId：#${s.id}「${s.title}」${s.chatId} → ${s.ownerSenderId}`,
    );
    s.chatId = s.ownerSenderId;
    changed = true;
  }
  return changed;
}

function load(): Schedule[] {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    cache = Array.isArray(parsed) ? (parsed as Schedule[]) : [];
  } catch {
    cache = [];
  }
  // 归一化后立刻回写：否则每次启动都要再修一遍，且期间新建的任务仍会落到老 chatId
  if (normalizePrivateChatIds(cache)) persist();
  return cache;
}

function persist(): void {
  try {
    mkdirSync(config.runtimeDir, { recursive: true });
    writeFileSync(file, JSON.stringify(load(), null, 2));
  } catch (error) {
    console.warn("[schedule] 持久化失败:", error);
  }
}

export function listSchedules(): Schedule[] {
  return [...load()];
}

export function getSchedule(id: string): Schedule | undefined {
  return load().find((s) => s.id === id);
}

/** 按 id 派生稳定错峰偏移（同一任务每次一致，重启后不变） */
function jitterOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % LIMITS.jitterMaxMs;
}

/** 人类可读的触发描述（回复用户 / 列表展示） */
export function describeTiming(t: ScheduleTiming): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (t.kind) {
    case "once":
      return `一次性 ${new Date(t.atMs).toLocaleString("zh-CN")}`;
    case "daily":
      return `每天 ${pad(t.hour)}:${pad(t.minute)}`;
    case "weekly":
      return `每周${["日", "一", "二", "三", "四", "五", "六"][t.weekday]} ${pad(t.hour)}:${pad(t.minute)}`;
    case "interval":
      return `每 ${Math.round(t.everyMs / 60_000)} 分钟`;
  }
}

export interface CreateScheduleInput {
  title: string;
  agentName: string;
  prompt: string;
  brief?: string;
  timing: ScheduleTiming;
  channel: string;
  chatId: string;
  chatType: "private" | "group";
  ownerSenderId: string;
  ownerSenderName: string;
  createdBy: string;
  then?: { agentName: string; prompt: string };
  /** 前置 schedule id：本轮等它跑完再启动（详见 Schedule.dependsOn） */
  dependsOn?: string;
}

/**
 * 校验并创建。校验不过返回 error 字符串（调用方转达给用户/员工，不抛）。
 * 关键约束：员工只能建一次性任务——周期任务由员工自建会导致「跑一次又排一个」的自我增殖。
 */
export function createSchedule(
  input: CreateScheduleInput,
): { schedule: Schedule } | { error: string } {
  const list = load();
  if (list.length >= LIMITS.total) {
    return { error: `定时任务总数已达上限（${LIMITS.total}），请先清理` };
  }
  if (list.filter((s) => s.agentName === input.agentName).length >= LIMITS.perAgent) {
    return { error: `员工「${input.agentName}」的定时任务已达上限（${LIMITS.perAgent}）` };
  }
  const isBoss = input.createdBy === "boss";
  if (!isBoss && input.timing.kind !== "once") {
    return {
      error: "员工只能创建一次性定时任务；周期性任务需要由主管创建（避免任务自我增殖）",
    };
  }
  const t = input.timing;
  if (t.kind === "interval" && t.everyMs < LIMITS.minIntervalMs) {
    return { error: `间隔不能小于 ${LIMITS.minIntervalMs / 1000} 秒` };
  }
  if (t.kind === "once" && t.atMs <= Date.now()) {
    return { error: "一次性任务的执行时间必须晚于当前时间" };
  }
  if ((t.kind === "daily" || t.kind === "weekly") && (t.hour < 0 || t.hour > 23 || t.minute < 0 || t.minute > 59)) {
    return { error: "时间不合法（hour 0-23、minute 0-59）" };
  }
  if (t.kind === "weekly" && (t.weekday < 0 || t.weekday > 6)) {
    return { error: "weekday 必须是 0-6（0=周日）" };
  }

  const schedule: Schedule = {
    id: randomUUID().slice(0, 6),
    title: input.title,
    agentName: input.agentName,
    prompt: input.prompt,
    ...(input.brief ? { brief: input.brief } : {}),
    timing: t,
    channel: input.channel,
    chatId: input.chatId,
    chatType: input.chatType,
    ownerSenderId: input.ownerSenderId,
    ownerSenderName: input.ownerSenderName,
    createdBy: input.createdBy,
    ...(input.then ? { then: input.then } : {}),
    ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
    enabled: true,
    runCount: 0,
    skipCount: 0,
    failCount: 0,
    createdAt: Date.now(),
  };
  list.push(schedule);
  persist();
  return { schedule };
}

export function updateSchedule(id: string, patch: Partial<Schedule>): Schedule | undefined {
  const s = getSchedule(id);
  if (!s) return undefined;
  Object.assign(s, patch);
  persist();
  return s;
}

/** 删除（once 触发后自动调用；用户取消也走这里） */
export function removeSchedule(id: string): Schedule | undefined {
  const list = load();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return undefined;
  const [removed] = list.splice(idx, 1);
  persist();
  return removed;
}

/** 停用（保留记录便于排查，如员工已不存在） */
export function disableSchedule(id: string, reason: string): Schedule | undefined {
  return updateSchedule(id, { enabled: false, disabledReason: reason });
}

/**
 * 是否到点该触发。
 * - daily/weekly：命中当天/当周的时间窗（fireWindowMs 内），且该窗口未跑过（lastRunKey 去重）
 * - interval：距上次执行 ≥ everyMs
 * - once：已过执行时间且在触发窗内（错过窗口不补跑，由调用方删除）
 * 返回 { due, key }——key 用于写 lastRunKey 做窗口去重。
 */
/**
 * 本轮的触发去重键（daily/weekly 才有）。
 * 依赖判定要靠它确认「前置在**本轮**已经跑过」——只看「前置最近一次成功」是不够的：
 * 周一 21:00 的优化师会看到复盘周日那次的成功记录就立刻放行，排序等于没做。
 */
export function cycleKeyOf(s: Schedule, now = new Date()): string | undefined {
  const t = s.timing;
  if (t.kind !== "daily" && t.kind !== "weekly") return undefined;
  return `${t.kind}:${now.toISOString().slice(0, 10)}`;
}

export function isDue(s: Schedule, now = new Date()): { due: boolean; key?: string; expired?: boolean } {
  const t = s.timing;
  const nowMs = now.getTime();

  // 连续失败后的退避窗口内不触发
  if (s.backoffUntil && nowMs < s.backoffUntil) return { due: false };

  if (t.kind === "interval") {
    const base = s.lastRunAt ?? s.createdAt;
    return { due: nowMs - base >= t.everyMs };
  }

  if (t.kind === "once") {
    if (nowMs < t.atMs) return { due: false };
    // 不补跑：超出触发窗口视为错过，直接过期删除
    if (nowMs - t.atMs > LIMITS.fireWindowMs) return { due: false, expired: true };
    return { due: true, key: `once:${t.atMs}` };
  }

  // daily / weekly：先算出今天（或本周目标日）的触发时刻
  if (t.kind === "weekly" && now.getDay() !== t.weekday) return { due: false };
  const target = new Date(now);
  target.setHours(t.hour, t.minute, 0, 0);
  // 整点错峰：同一时刻的多个任务按 id 稳定摊开，避免一起打爆并发闸门
  const diff = nowMs - (target.getTime() + jitterOf(s.id));
  // 不补跑：只在 [触发时刻, 触发时刻+窗口] 内触发
  if (diff < 0 || diff > LIMITS.fireWindowMs) return { due: false };
  const key = cycleKeyOf(s, now)!;
  if (s.lastRunKey === key) return { due: false };
  return { due: true, key };
}

/**
 * 种子：把「每日复盘」建成一条内置定时任务（幂等，按 seedKey 去重）。
 * 复盘从此走统一调度器 + boss 主干，不再是绕过任务体系的硬编码特例。
 */
export function seedSchedule(
  seedKey: string,
  input: CreateScheduleInput,
): Schedule | undefined {
  const list = load();
  const existing = list.find((s) => s.seedKey === seedKey);
  if (existing) return existing;
  const created = createSchedule(input);
  if ("error" in created) {
    console.warn(`[schedule] 内置任务 ${seedKey} 创建失败：${created.error}`);
    return undefined;
  }
  updateSchedule(created.schedule.id, { seedKey });
  return created.schedule;
}
