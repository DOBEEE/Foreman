import { getAgent } from "../agents/registry.js";
import { dispatchFollowUp, dispatchScheduledTask } from "../boss/boss.js";
import { deliver, notifyTarget } from "../boss/delivery.js";
import { subscribe } from "../boss/event-bus.js";
import { sweepTempWorkers } from "../boss/temp-worker.js";
import { sweepTaskWorkspaces } from "../boss/task-workspace.js";
import { cleanupExpiredSessions } from "../runtime/session-store.js";
import { clusterDigest, ripeClusters } from "../boss/temp-ledger.js";
import { pendingNewHireSlugs } from "../boss/proposals.js";
import { acquireLock, releaseLock } from "../channels/lock.js";
import { startBenchSchedule } from "../bench/schedule.js";
import { taskManager as tm } from "../boss/task-manager.js";
import type { Task, TaskState } from "../boss/types.js";
import { config } from "../config/index.js";
import {
  cycleKeyOf,
  describeTiming,
  disableSchedule,
  getSchedule,
  isDue,
  LIMITS,
  listSchedules,
  removeSchedule,
  seedSchedule,
  updateSchedule,
  type Schedule,
} from "./schedule-store.js";

/**
 * 定时任务调度器：只负责「到点触发」，执行一律回到 boss 主干
 * （dispatchScheduledTask → 任务队列 / 并发闸门 / 验收 / Dashboard / 可取消）。
 *
 * 边界处理：
 * - **员工繁忙**：overlap=skip（默认）跳过本次并计数；queue 则入队等待
 * - **单实例约束**：同一 schedule 上一个任务还活着时不再重复派发（防同任务并行踩踏）
 * - **不补跑**：只在触发时刻后的窗口内触发（见 LIMITS.fireWindowMs），错过就等下个周期
 * - **重启不双跑**：daily/weekly 用日期键去重，interval 以 lastRunAt 为基准
 * - **员工失踪**（被删/改名）：停用该 schedule 并通知创建者所在会话，不静默失败
 * - **多进程**：进程级单实例锁，避免两个 serve 实例重复触发
 * - **失败不自动重试**：验收/失败播报由 boss 主干负责，调度器不重试以免烧 token
 * - **投递可靠**：结果走统一投递层（活跃会话失效则渠道主动推送）
 */

const SCAN_INTERVAL_MS = 60_000;
const LOCK_KEY = "scheduler";
/** 归纳闸门的伪 scheduleId：借 runningTaskOf 做单实例约束，但不进 schedule 存储 */
const CONSOLIDATION_ID = "consolidation";
/** 仍占着这个 schedule 的任务状态：这三种都还没到终态，不能再叠一个实例 */
const LIVE_TASK_STATES = new Set<TaskState>(["queued", "running", "waiting_user"]);
/** 优化师的旧默认时刻（周一 10:00），只用于识别「用户没手动改过」的老记录并迁移 */
const LEGACY_OPTIMIZER_HOUR = 10;

/** 每个 schedule 当前在跑的任务：taskId → scheduleId（用于单实例约束与 then 触发） */
const runningTaskOf = new Map<string, string>();

/**
 * 反查任务归属哪个 schedule：内存映射优先，没有则按持久化的 lastTaskId 认领。
 *
 * 只靠内存映射会在 serve 重启后丢掉所有在途任务的归属，于是它们的终态无人认领：
 * failCount 永远不增长，阶梯退避与「连续失败自动停用」整条安全网都不生效。
 * 实测每日复盘 08-06 / 08-07 连着两天 failed，schedules.json 里 failCount 仍是 0。
 */
function scheduleOfTask(taskId: string): string | undefined {
  return runningTaskOf.get(taskId) ?? listSchedules().find((s) => s.lastTaskId === taskId)?.id;
}

function notifyOwner(s: Schedule, text: string): void {
  void deliver(
    {
      channel: s.channel,
      chatId: s.chatId,
      chatType: s.chatType,
      ownerSenderId: s.ownerSenderId,
    },
    text,
  );
}

/** 上一个实例是否仍在进行（running / waiting_user / queued） */
export function stillRunning(s: Schedule): boolean {
  if (!s.lastTaskId) return false;
  // 以任务库里的真实状态为准：内存映射在 serve 重启后是空的，会把「还在跑」判成 false，
  // 于是同一 schedule 被叠上第二个实例（实测每日复盘因此出现多个并发实例）。
  const task = tm.get(s.chatId, s.lastTaskId);
  if (task) return LIVE_TASK_STATES.has(task.state);
  return runningTaskOf.get(s.lastTaskId) === s.id;
}

/**
 * 任务到终态时给它所属的 schedule 记账：解除单实例占用、失败退避 / 自动停用、成功触发后继。
 *
 * 独立成导出函数（而不是写在 subscribe 回调里）是为了可测——这段逻辑此前只能靠线上
 * 跑一天才知道对不对，而它恰好错了：归因只认内存映射，重启后在途任务的终态无人认领。
 */
export function accountTerminalTask(
  taskId: string,
  to: Extract<TaskState, "done" | "failed" | "cancelled">,
  task: Pick<Task, "error" | "result">,
): void {
  const scheduleId = scheduleOfTask(taskId);
  if (!scheduleId) return;
  runningTaskOf.delete(taskId);
  const s = getSchedule(scheduleId);
  if (!s) return;
  // 同一轮只记一次账：归因按 lastTaskId 反查，同一任务的终态事件可能来第二次
  // （返工后再次失败、重启后事件重放），否则 failCount 会虚高、then 后继会被重复派发
  if (s.lastAccountedTaskId === taskId) return;

  if (to === "cancelled") {
    updateSchedule(s.id, { lastAccountedTaskId: taskId });
    return;
  }

  if (to === "failed") {
    // 连续失败阶梯退避；达到阈值自动停用，避免坏任务每个周期都刷屏
    const fails = s.failCount + 1;
    if (fails >= LIMITS.maxConsecutiveFailures) {
      disableSchedule(s.id, `连续失败 ${fails} 次`);
      updateSchedule(s.id, {
        failCount: fails,
        backoffUntil: undefined,
        lastAccountedTaskId: taskId,
      });
      notifyOwner(
        s,
        `⚠️ 定时任务「${s.title}」已连续失败 ${fails} 次，我先把它停用了，免得一直打扰你。` +
          `\n最后一次的失败原因：${(task.error ?? "未知").slice(0, 200)}` +
          `\n修好后跟我说「恢复定时任务 #${s.id}」，或者重新安排一个。`,
      );
      return;
    }
    const backoff = LIMITS.backoffLadder[Math.min(fails - 1, LIMITS.backoffLadder.length - 1)];
    updateSchedule(s.id, {
      failCount: fails,
      backoffUntil: Date.now() + backoff,
      lastAccountedTaskId: taskId,
    });
    console.warn(
      `[scheduler] ${s.id}「${s.title}」第 ${fails} 次失败，退避 ${backoff / 60000} 分钟后再试`,
    );
    return;
  }

  // 成功即清零失败计数与退避
  updateSchedule(s.id, {
    lastAccountedTaskId: taskId,
    ...(s.failCount > 0 || s.backoffUntil ? { failCount: 0, backoffUntil: undefined } : {}),
  });
  if (!s.then) return;
  // 后继任务必须拿到上游产出，否则「根据上一步的结果做 X」是空话
  const upstream = (task.result ?? "").trim();
  dispatchFollowUp({
    agentName: s.then.agentName,
    prompt: upstream
      ? `${s.then.prompt}\n\n【上游任务「${s.title}」的产出（由 ${s.agentName} 完成，据此执行）】\n${upstream.slice(0, 6000)}`
      : s.then.prompt,
    channel: s.channel,
    chatId: s.chatId,
    chatType: s.chatType,
    ownerSenderId: s.ownerSenderId,
    ownerSenderName: s.ownerSenderName,
  });
}

function fireOne(s: Schedule, key?: string): void {
  // 单实例约束：上一轮还没结束就不再叠一个（周期短 / 执行久的常见场景）
  if (stillRunning(s)) {
    updateSchedule(s.id, { skipCount: s.skipCount + 1 });
    console.log(`[scheduler] ${s.id}「${s.title}」上一实例仍在进行，跳过本次`);
    return;
  }

  const result = dispatchScheduledTask({
    scheduleId: s.id,
    title: s.title,
    agentName: s.agentName,
    prompt: s.prompt,
    ...(s.brief ? { brief: s.brief } : {}),
    channel: s.channel,
    chatId: s.chatId,
    chatType: s.chatType,
    ownerSenderId: s.ownerSenderId,
    ownerSenderName: s.ownerSenderName,
  });

  if (result.status === "missing") {
    disableSchedule(s.id, `员工「${s.agentName}」已不存在`);
    notifyOwner(
      s,
      `⚠️ 定时任务「${s.title}」已停用：负责它的员工「${s.agentName}」不存在了。` +
        `如需继续，请重新创建并指定现有员工。`,
    );
    return;
  }

  if (result.queued) {
    console.log(`[scheduler] ${s.id}「${s.title}」工作目录被占用，已排队（保证不踩踏同一 clone）`);
  }
  updateSchedule(s.id, {
    lastRunAt: Date.now(),
    ...(key ? { lastRunKey: key } : {}),
    lastTaskId: result.taskId,
    runCount: s.runCount + 1,
    skipCount: 0,
    // 本轮已经跑掉了：不管是正常到点还是等前置结束后补发的，等待态都该清掉
    awaitingDep: undefined,
  });
  if (result.taskId) runningTaskOf.set(result.taskId, s.id);
  // 一次性任务触发后即删除，不留垃圾
  if (s.timing.kind === "once") removeSchedule(s.id);
}

/**
 * 依赖闸门：一条声明了 dependsOn 的 schedule，本轮能不能启动。
 *
 * - `free`：没声明依赖，或前置已不存在 / 被停用 → 按无依赖处理。
 *   **宁可不排序也要跑**：前置被删掉时若继续等，下游就退化成「静默永不执行」。
 * - `waiting`：前置本轮还没触发，或它派出的任务还没到终态。
 * - `ready`：前置本轮已经结束，可以跟上了。
 * - `giveup`：等超过 LIMITS.depWaitMs，放弃本轮。
 *
 * 「结束」含失败：前置一失败就让下游永久不跑，又是一次静默失效；而且复盘跑挂了本身
 * 就是优化师最该分析的素材，没有理由因此跳过它。
 */
export function dependencyGate(
  s: Schedule,
  now = new Date(),
): "free" | "waiting" | "ready" | "giveup" {
  if (!s.dependsOn) return "free";
  const dep = getSchedule(s.dependsOn);
  if (!dep || !dep.enabled) return "free";
  if (s.awaitingDep && now.getTime() - s.awaitingDep.since > LIMITS.depWaitMs) return "giveup";
  // 前置本轮跑过没：按周期键比对，只看「最近一次成功」会让周一的下游放过上周日那次
  const depKey = cycleKeyOf(dep, now);
  if (depKey && dep.lastRunKey !== depKey) return "waiting";
  return stillRunning(dep) ? "waiting" : "ready";
}

function scan(): void {
  const now = new Date();
  // 顺带清理过期临时工：本进程持有调度单实例锁，不会与别的进程抢着删同一批文件。
  // 三个清理各自 try/catch：一个抛错不能让后面的清理和整轮调度扫描跟着停。
  try {
    sweepTempWorkers(now.getTime());
  } catch (error) {
    console.error("[scheduler] 临时工清理失败:", error);
  }
  try {
    sweepTaskWorkspaces(now.getTime());
  } catch (error) {
    console.error("[scheduler] 任务工作目录清理失败:", error);
  }
  try {
    // cleanupExpiredSessions 此前定义了却没有任何调用点：loadSession 会拒绝超期会话，
    // 所以功能上没问题，但磁盘上的 session 文件只增不减。并发槽会把产生速率翻倍。
    cleanupExpiredSessions();
  } catch (error) {
    console.error("[scheduler] 过期会话清理失败:", error);
  }
  try {
    consolidationGate();
  } catch (error) {
    console.error("[scheduler] 归纳闸门失败:", error);
  }
  for (const s of listSchedules()) {
    if (!s.enabled) continue;

    // 已在等前置：前置一结束就用存下的触发键补发。不能重走 isDue——
    // daily/weekly 的 10 分钟窗口早过了，会被判成「错过、不补跑」
    if (s.awaitingDep) {
      const gate = dependencyGate(s, now);
      if (gate === "waiting") continue;
      if (gate === "giveup") {
        const waited = Math.round((now.getTime() - s.awaitingDep.since) / 60000);
        updateSchedule(s.id, {
          awaitingDep: undefined,
          lastRunKey: s.awaitingDep.key,
          skipCount: s.skipCount + 1,
        });
        console.warn(`[scheduler] ${s.id}「${s.title}」等前置超过 ${waited} 分钟，放弃本轮`);
        notifyOwner(
          s,
          `⏰ 定时任务「${s.title}」本轮没跑：它排在「${getSchedule(s.dependsOn ?? "")?.title ?? s.dependsOn}」之后，` +
            `等了 ${waited} 分钟对方还没结束，按约定放弃本轮，下个周期再来。`,
        );
        continue;
      }
      try {
        fireOne(s, s.awaitingDep.key);
      } catch (error) {
        console.error(`[scheduler] ${s.id} 依赖满足后触发失败:`, error);
      }
      continue;
    }

    const { due, key, expired } = isDue(s, now);
    if (expired) {
      // 一次性任务错过了触发窗口（进程停机等）：按「不补跑」约定丢弃并告知
      removeSchedule(s.id);
      notifyOwner(
        s,
        `⏰ 定时任务「${s.title}」的执行时间已错过（进程当时未运行），按约定不补跑，已移除。`,
      );
      continue;
    }
    if (!due) continue;

    // 到点了但前置还没结束：转等待态挂住本轮的键，别丢掉这一轮
    if (key && dependencyGate(s, now) === "waiting") {
      updateSchedule(s.id, { awaitingDep: { key, since: now.getTime() } });
      console.log(
        `[scheduler] ${s.id}「${s.title}」到点，但排在「${getSchedule(s.dependsOn ?? "")?.title ?? s.dependsOn}」之后，等它结束`,
      );
      continue;
    }

    try {
      fireOne(s, key);
    } catch (error) {
      console.error(`[scheduler] ${s.id} 触发失败:`, error);
    }
  }
}

/**
 * 归纳闸门：**代码算数，够了才叫 hr**。
 *
 * 不做成定时任务——持久台账已经提供了样本量，「按周攒样本」的理由不存在；而每天定时
 * 叫 hr 看一眼「今天够不够三个」，绝大多数天数都是白烧一次调用。挂在扫描循环上则是
 * 发现即触发（第 3 个同类落地后最迟一个周期内），空闲天数零成本。
 *
 * 自去重靠两层：进提案的记录标 proposed 后不再参与聚类 + 同一能力域已有待审提案时跳过。
 */
function consolidationGate(): void {
  // 上一轮归纳还在跑就不再叠一个：扫描每 60s 一次，而 hr 设计岗位要几分钟，
  // 只靠「已有待审提案」去重不够——提案是在它跑完之后才出现的
  if ([...runningTaskOf.values()].includes(CONSOLIDATION_ID)) return;
  const taken = pendingNewHireSlugs();
  const ripe = ripeClusters().filter((c) => !taken.has(c.capabilitySlug));
  if (ripe.length === 0) return;

  const target = notifyTarget();
  const digest = clusterDigest(ripe);
  const slugs = ripe.map((c) => c.capabilitySlug).join("、");
  const result = dispatchScheduledTask({
    scheduleId: CONSOLIDATION_ID,
    title: "临时工归纳建岗",
    agentName: "hr",
    prompt: [
      "以下能力域已经反复由临时工接手，说明团队缺一个固定岗位。请归纳成**通用正式岗位**并产出待审建岗提案。",
      "",
      digest,
      "",
      "要求：",
      "- 每条记录里的「当时的提示词」是归档 profile 文件路径，用 Read 打开回看那几份提示词，从中提炼共性。",
      "- 设计的是**面向能力域**的岗位，不是某一次活的复刻：systemPrompt 里不要出现具体仓库名/路径/文件名。",
      "- 近义能力域可以合并成一个岗位一起提；凑不够证据的一律不提，宁可不提。",
      "- 职责卡（routeHint）必须含【选我当】/【别选我当】两段，对照现有成员划清边界。",
      "- 用 propose_new_hire 工具提交（不要直接落盘员工文件）。",
    ].join("\n"),
    brief: `归纳能力域：${slugs}`,
    ...target,
    ownerSenderName: "系统",
  });
  if (result.status === "missing") {
    console.warn("[scheduler] 归纳闸门触发但 hr 员工不存在，跳过");
    return;
  }
  if (result.taskId) runningTaskOf.set(result.taskId, CONSOLIDATION_ID);
  console.log(`[scheduler] 归纳闸门触发：${ripe.length} 个能力域（${slugs}）→ hr 任务 #${result.taskId}`);
}

/**
 * 种下内置定时任务：每日复盘 + 每周提示词优化。
 * 投递目标取 config.retro 的通知配置（群优先、其次单聊），都没配则落在 CLI 会话。
 * 幂等（seedKey 去重），用户手动改过时间/停用也不会被覆盖。
 */
function seedBuiltins(): void {
  const target = notifyTarget();
  let retroId: string | undefined;
  if (config.retro.schedule) {
    retroId = seedSchedule("builtin:daily-retro", {
      title: "每日复盘",
      agentName: "retro",
      prompt:
        "执行每日复盘：回顾今天团队各员工的执行记录，提炼可复用经验写入对应岗位的经验库，" +
        "并给出一份复盘总结（今天做了什么、暴露了什么问题、沉淀了哪些经验）。",
      timing: { kind: "daily", hour: config.retro.hour, minute: 0 },
      ...target,
      ownerSenderName: "系统",
      createdBy: "boss",
    })?.id;
  }
  // 提示词优化按周跑：提示词是行为契约不宜频繁改，且每周样本量才够支撑高置信度提案。
  // 与复盘同点触发、排在它之后（dependsOn）：复盘的当天记录里有「员工笔记与实际执行不符」
  // 「boss 代答答错了」这类归因线索，是明确写给优化师看的，得等它落盘。
  if (config.optimizer.schedule) {
    const optimizer = seedSchedule("builtin:weekly-optimize", {
      title: "每周提示词优化分析",
      agentName: "optimizer",
      prompt:
        `分析最近 ${config.optimizer.days} 天的执行日志，归因用户员工的失败与低效模式，` +
        "对其提示词产出待审优化提案（内置岗位不在范围内），并给出一份分析报告。",
      timing: {
        kind: "weekly",
        weekday: config.optimizer.weekday,
        hour: config.optimizer.hour,
        minute: 0,
      },
      ...target,
      ownerSenderName: "系统",
      createdBy: "boss",
      ...(retroId ? { dependsOn: retroId } : {}),
    });
    if (optimizer) alignOptimizerAfterRetro(optimizer, retroId);
  }
}

/**
 * 把已种下的优化师记录对齐到「与复盘同点、排在其后」。
 *
 * 必须单独做：seedSchedule 遇到已存在的 seedKey 就原样返回、**不会更新**，所以改种子
 * 只对新装环境生效，老环境仍停在「周一 10:00、无依赖」。
 *
 * 幂等判据是**时刻是否还是默认值**，不是「有没有 dependsOn」——后者会在只改了一半时
 * （dependsOn 已写、时刻还没挪）提前退出，把记录永久卡在半迁移态（实测撞上过：dev server
 * 热加载时 scheduler 是新的、config 还是旧的）。
 * 时间与依赖绑定处理：用户自己挪过时间就整条不碰。否则一条 15:00 的优化师挂在 21:00 的
 * 复盘后面，每周都要白等 4 小时再放弃。
 */
function alignOptimizerAfterRetro(optimizer: Schedule, retroId?: string): void {
  if (!retroId) return;
  const t = optimizer.timing;
  if (t.kind !== "weekly") return;
  if (optimizer.dependsOn === retroId && t.hour === config.optimizer.hour) return;
  // 只认「还是默认时刻」：旧默认，或当前默认（半迁移态）
  if (t.hour !== LEGACY_OPTIMIZER_HOUR && t.hour !== config.optimizer.hour) return;
  updateSchedule(optimizer.id, {
    timing: { kind: "weekly", weekday: t.weekday, hour: config.optimizer.hour, minute: 0 },
    dependsOn: retroId,
  });
  console.log(
    `[scheduler] 「${optimizer.title}」已对齐到 ${config.optimizer.hour}:00 并排在「每日复盘」之后`,
  );
}

/** 启动调度器；返回停止函数。未拿到单实例锁则不参与调度（只读不写） */
export async function startScheduler(): Promise<() => void> {
  const locked = await acquireLock(LOCK_KEY);
  if (!locked) {
    console.warn("[scheduler] 已有其他进程在调度，本进程跳过定时任务扫描");
    return () => {};
  }

  // 任务终态时解除单实例占用，并触发线性后继（then）
  const unsubscribe = subscribe(
    (e) => {
      if (e.kind !== "task.state_change") return;
      if (e.to !== "done" && e.to !== "failed" && e.to !== "cancelled") return;
      accountTerminalTask(e.taskId, e.to, e.task);
    },
    { kinds: ["task.state_change"] },
  );

  seedBuiltins();

  const enabled = listSchedules().filter((s) => s.enabled);
  console.log(
    `[scheduler] 定时任务调度已启动：${enabled.length} 条生效` +
      (enabled.length
        ? `（${enabled.map((s) => `${s.title}·${describeTiming(s.timing)}`).join("、")}）`
        : ""),
  );

  const timer = setInterval(scan, SCAN_INTERVAL_MS);
  timer.unref?.();
  // 启动即扫一次（进程刚拉起时补上当前窗口内的任务）
  scan();

  // 一层回归跟调度器共用这把单实例锁：多进程各跑一次评测会互相污染 runtimeState
  const stopBench = startBenchSchedule();

  return () => {
    clearInterval(timer);
    stopBench();
    unsubscribe();
    releaseLock(LOCK_KEY);
  };
}

/** 校验 schedule 指向的员工是否存在（创建时校验，避免建了个跑不起来的） */
export function agentExists(agentName: string): boolean {
  return getAgent(agentName) !== undefined;
}
