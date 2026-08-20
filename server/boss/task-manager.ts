import { randomUUID } from "node:crypto";
import { loadAgentProfile } from "../config/agent-profile.js";
import type { Contract } from "../core/contract.js";
import { loadChatTasks, listAllChatIds, saveChatTasks } from "./store.js";
import {
  OCCUPYING_STATES,
  TERMINAL_STATES,
  resumableSessionId,
  type Task,
  type TaskState,
} from "./types.js";
import { config } from "../config/index.js";

/**
 * 确定性任务管理：状态机 + 队列 + 员工并发槽占用（缺省 1 = 单任务）。全部落盘（重启不丢）。
 * 不含任何 LLM 调用——boss 的「记性」是这里，不是模型上下文。
 */
export class TaskManager {
  /** 内存索引：chatId → 任务列表（与磁盘同步） */
  private cache = new Map<string, Task[]>();

  private tasks(chatId: string): Task[] {
    let list = this.cache.get(chatId);
    if (!list) {
      list = loadChatTasks(chatId);
      this.cache.set(chatId, list);
    }
    return list;
  }

  private persist(chatId: string): void {
    saveChatTasks(chatId, this.tasks(chatId));
  }

  /** 该员工当前全部占用中的任务（并发槽下可能多于一个，按创建时间稳定排序） */
  occupyingTasks(chatId: string, agentName: string): Task[] {
    return this.tasks(chatId)
      .filter((t) => t.agentName === agentName && OCCUPYING_STATES.includes(t.state))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * 岗位**显式声明**的并发预算；没声明返回 undefined。
   *
   * 区分「声明为 1」和「压根没声明」是必要的：`forceStart`（定时任务）历史语义是完全
   * 免排队，只有在用户对这个岗位明确设过预算时才该受约束——见 `create` 里的判定。
   */
  private declaredSlots(agentName: string): number | undefined {
    const declared = loadAgentProfile(agentName)?.maxParallel;
    return typeof declared === "number" && declared >= 1 ? Math.floor(declared) : undefined;
  }

  /**
   * 该员工在本 chat 的并发槽上限。缺省 1 = 串行，与历史行为一致。
   *
   * 直接读 profile 而不是走 agent registry：registry 会反向 import 到 boss，
   * 而 agent-profile 在 config 层，这条方向是干净的（同 `setTerminalHook` 用注入式
   * 回调避开成环的理由）。
   */
  private slotsOf(agentName: string): number {
    return this.declaredSlots(agentName) ?? 1;
  }

  /** 该员工还能同时接几件活（<= 0 表示满了） */
  freeSlots(chatId: string, agentName: string): number {
    return this.slotsOf(agentName) - this.occupyingTasks(chatId, agentName).length;
  }

  /**
   * 某员工是否被占满（占用态任务数已达并发槽上限）。
   *
   * **刻意保留这个名字与布尔签名**：`create` / `retryFailed` / `dequeueNext` 三处判定
   * 问的都是「现在能不能开跑」，换成计数后语义不变，于是那三处零改动即正确。
   */
  isEmployeeBusy(chatId: string, agentName: string): boolean {
    return this.freeSlots(chatId, agentName) <= 0;
  }

  /**
   * 该员工当前占用中的任务（用于「正在忙 xxx」文案）。
   * 并发槽下只取最早那个——需要全部时用 `occupyingTasks`。
   */
  occupyingTask(chatId: string, agentName: string): Task | undefined {
    return this.occupyingTasks(chatId, agentName)[0];
  }

  /**
   * 该员工排队中的任务数（只数「等员工空出来」的）。
   *
   * 刻意排除等前置任务的那些：本函数参与「他正忙，前面还有 N 个」文案，而等前置的任务
   * 并不在这条队伍里——它等的是另一个任务而不是这个员工，算进去就是对用户说假话。
   */
  queuedCount(chatId: string, agentName: string): number {
    return this.tasks(chatId).filter(
      (t) => t.agentName === agentName && t.state === "queued" && this.depSatisfied(t),
    ).length;
  }

  /**
   * 前置依赖是否已满足：没声明前置恒满足；前置查不到（被清理/跨 chat）也放行。
   *
   * 查不到即放行是刻意的：**宁可不排序也要跑**。若一直等下去，前置被删掉的任务就会
   * 退化成「静默永不执行」——这类无声失效比顺序错乱难发现得多。
   */
  depSatisfied(task: Task): boolean {
    if (!task.afterTask) return true;
    const dep = this.get(task.chatId, task.afterTask);
    if (!dep) return true;
    return TERMINAL_STATES.includes(dep.state);
  }

  /** 可以开跑：依赖已满足，且没有交接决策正在处理它 */
  startable(task: Task): boolean {
    return !task.handoffPending && this.depSatisfied(task);
  }

  /** 等着某个任务干完的后继（按创建时间，保证多后继的处理顺序稳定） */
  successorsOf(chatId: string, taskId: string): Task[] {
    return this.tasks(chatId)
      .filter((t) => t.afterTask === taskId && t.state === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 新建任务：员工空闲→running，忙→queued。返回任务 + 是否立即可执行 */
  create(input: {
    channel: string;
    chatId: string;
    chatType: "private" | "group";
    ownerSenderId: string;
    ownerSenderName: string;
    agentName: string;
    prompt: string;
    /** 续派：继承某员工既有会话，续上下文（boss 判定为追加诉求时传入） */
    resumeSessionId?: string;
    /**
     * 无视员工占用直接开跑（定时任务用）：定时任务每次都是全新会话，
     * 不存在「与用户对话串上下文」的问题；只有共享工作目录的岗位才需要排队。
     */
    forceStart?: boolean;
    /** 前置任务 id：声明了就一定先排队，等它到终态再由交接决策放行 */
    afterTask?: string;
    /** 验收标准（结构化留存，验收时作为独立段落逐条核对） */
    acceptance?: string;
    /** 可机验的产出合约（零模型硬查） */
    contract?: Contract;
    /** 本次指定的验收员（一次性覆盖岗位配置的 reviewer） */
    reviewer?: string;
  }): { task: Task; startNow: boolean } {
    const now = Date.now();
    // 声明了前置就必须排队：员工此刻恰好空闲也不能开跑，否则「等 A 干完」等于没声明。
    // forceStart 也不能越过这条——定时任务同样得守住顺序。
    const waitsDep = Boolean(input.afterTask);
    // forceStart（定时任务）历史语义是完全免排队——它免的是「员工正陪用户聊天就得等」。
    // 但岗位一旦**显式声明**了并发预算，那就是用户对这个岗位并发度的明确态度，定时任务
    // 也得守：否则 coder 切到 per-task 后 `!needsSerialRun()` 恒真、forceStart 恒开，
    // maxParallel 形同不存在。没声明的岗位（如 per-run 的 alert-diagnosis）保持原样，
    // 不能顺手把它们的定时任务从「立即并行」改成「排队」。
    const capped = this.declaredSlots(input.agentName) != null;
    const busy = waitsDep
      ? true
      : input.forceStart
        ? capped && this.freeSlots(input.chatId, input.agentName) <= 0
        : this.isEmployeeBusy(input.chatId, input.agentName);
    const { resumeSessionId, forceStart: _forceStart, ...rest } = input;
    const task: Task = {
      id: randomUUID().slice(0, 6),
      ...rest,
      ...(resumeSessionId ? { sessionId: resumeSessionId, sessionRuntime: config.runtimeKind } : {}),
      state: busy ? "queued" : "running",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks(input.chatId).push(task);
    this.persist(input.chatId);
    return { task, startNow: !busy };
  }

  get(chatId: string, taskId: string): Task | undefined {
    return this.tasks(chatId).find((t) => t.id === taskId);
  }

  /** 最近 N 条任务（按更新时间倒序，任意状态），供 boss 判定「追加诉求延续哪个员工」 */
  recentTasks(chatId: string, limit = 5): Task[] {
    return [...this.tasks(chatId)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /**
   * 某员工在本 chat 最近一次带 sessionId 的任务的会话（续派时 resume 用）。
   *
   * **并发岗位一律返回 undefined**：这个「最近活跃即用户所指」的启发式只在员工一次只干
   * 一件事时成立。他手上同时有两件活时，它会把另一件活的会话接到这件上——上下文污染
   * 且完全无声（不报错、不提示，只是回答开始跑偏）。宁可新开一个干净会话。
   * 需要精确续某个任务时走 taskId（`opContinueTask` 的显式分支），不靠猜。
   */
  latestSessionOf(chatId: string, agentName: string): string | undefined {
    if ((this.declaredSlots(agentName) ?? 1) > 1) return undefined;
    return [...this.tasks(chatId)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .find((t) => t.agentName === agentName && resumableSessionId(t, config.runtimeKind))
      ?.sessionId;
  }

  /** 当前 chat 处于 waiting_user 的任务（归属判定 + 重播提醒用） */
  waitingTasks(chatId: string): Task[] {
    return this.tasks(chatId).filter((t) => t.state === "waiting_user");
  }

  /** 活跃任务（running / waiting_user / queued），/status 看板用 */
  activeTasks(chatId: string): Task[] {
    return this.tasks(chatId).filter(
      (t) => !TERMINAL_STATES.includes(t.state),
    );
  }

  /**
   * 最近已收尾的任务（done / failed），按更新时间倒序。
   * boss 回答「刚才那个结果里…」「那个为什么失败」这类追问必须看得到它们——
   * activeTasks 刻意排除了收尾任务，只靠它会让 boss 对刚发生的事完全失明。
   *
   * **默认排除定时任务**（见 Task.scheduled）：复盘这类每天都跑的任务会把 limit 个槽位
   * 全占满，把用户自己的任务挤出视野。默认排除而非默认包含，是因为本函数的产物几乎都会
   * 进 LLM 上下文——将来漏改某个调用点时，「排除」是安全的那一侧。
   * 需要全量的场合（list_tasks 工具、看板）显式传 includeScheduled。
   */
  recentFinishedTasks(
    chatId: string,
    limit = 5,
    opts?: { includeScheduled?: boolean },
  ): Task[] {
    return this.tasks(chatId)
      .filter((t) => t.state === "done" || t.state === "failed")
      .filter((t) => opts?.includeScheduled || !t.scheduled)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /**
   * 当前有任务记录的所有 chatId（含历史）。Dashboard 汇总用。
   * 首次调用会把磁盘所有 chat 文件懒加载进 cache，供后续跨 chat 查询。
   */
  allChatIds(): string[] {
    const ids = new Set(this.cache.keys());
    for (const id of listAllChatIds()) {
      ids.add(id);
      if (!this.cache.has(id)) this.tasks(id); // 触发加载
    }
    return [...ids];
  }

  /** 跨所有 chat 平铺任务（Dashboard 主视图数据源） */
  allTasks(): Task[] {
    const out: Task[] = [];
    for (const id of this.allChatIds()) out.push(...this.tasks(id));
    return out;
  }

  /** 跨所有 chat 的活跃任务（running / waiting_user / queued） */
  allActiveTasks(): Task[] {
    return this.allTasks().filter(
      (t) => !TERMINAL_STATES.includes(t.state),
    );
  }

  update(chatId: string, taskId: string, patch: Partial<Task>): Task | undefined {
    const task = this.get(chatId, taskId);
    if (!task) return undefined;
    /**
     * 写 sessionId 时**统一打上 runtime 归属**。
     *
     * 放在这个唯一写入口，而不是散在十余处 `tm.update({ sessionId })` 调用点——
     * 漏掉任何一处，那条任务的 id 就成了无主 id，切 runtime 后拿它去 resume 会致命失败
     * （实测 Qoder worker exit 42：`Invalid session identifier`）。
     */
    const stamped =
      patch.sessionId != null && patch.sessionRuntime == null
        ? { ...patch, sessionRuntime: config.runtimeKind }
        : patch;
    Object.assign(task, stamped, { updatedAt: Date.now() });
    this.persist(chatId);
    return task;
  }

  /**
   * 任务进入终态时的同步钩子（由 boss 层注册，避免 task-manager → boss 反向依赖）。
   *
   * 为什么挂在写入口而不是 event-bus：终态的代码路径是「改状态 → 播报 → advanceEmployee」
   * **同一 tick**。交接决策是异步的，挂 bus 也来不及在 `advanceEmployee` 之前给后继打闸，
   * 于是后继会被用**原简报**抢跑。挂在这里还顺带覆盖三个 bus 收不到的洞：未知 agent 那条
   * 出口（漏发 publishStateChange）、`releaseTempWorker` 里的 cancel（完全不发事件）、
   * 以及重启恢复批量改盘。
   *
   * 约定：回调**必须同步完成打闸**，异步决策自行 fire-and-forget。本方法不 await。
   */
  private onTerminal?: (task: Task, to: TaskState) => void;

  setTerminalHook(hook: (task: Task, to: TaskState) => void): void {
    this.onTerminal = hook;
  }

  /** 改状态并在进入终态时触发钩子（所有状态变更的唯一收口） */
  private setState(chatId: string, taskId: string, state: TaskState): void {
    const task = this.update(chatId, taskId, { state });
    if (!task) return;
    if (TERMINAL_STATES.includes(state)) {
      try {
        this.onTerminal?.(task, state);
      } catch (error) {
        // 钩子失败不能反过来影响任务本身的终态落盘
        console.error("[task] 终态钩子失败:", error);
      }
    }
  }

  markRunning(chatId: string, taskId: string): void {
    // 人为推进一轮（首次派发 / 用户回答后 resume）→ 自动续跑预算重新给满
    this.update(chatId, taskId, { state: "running", autoContinues: 0 });
  }

  markWaiting(chatId: string, taskId: string, question: string, sessionId?: string): void {
    this.update(chatId, taskId, { state: "waiting_user", question, sessionId });
  }

  markDone(chatId: string, taskId: string, result: string, sessionId?: string): void {
    this.update(chatId, taskId, {
      result,
      question: undefined,
      sessionId,
    });
    this.setState(chatId, taskId, "done");
  }

  markFailed(chatId: string, taskId: string, error: string): void {
    this.update(chatId, taskId, { error, question: undefined });
    this.setState(chatId, taskId, "failed");
  }

  /**
   * 复活失败任务（或抢跑等待自动重试中的任务）：沿用原 taskId/session。
   *
   * 接受两种状态：
   * - state === "failed"：常规重试
   * - state === "running" && retryScheduledAt：正在等自动重试的 setTimeout，
   *   实际没有 LLM 在跑。用户手动重试时抢跑它——清掉 retryScheduledAt
   *   使 setTimeout 回调判 state 变化后退出。
   */
  retryFailed(chatId: string, taskId: string): { task: Task; startNow: boolean } | undefined {
    const task = this.get(chatId, taskId);
    if (!task) return undefined;

    const isPendingRetry = task.state === "running" && task.retryScheduledAt != null;
    if (task.state !== "failed" && !isPendingRetry) return undefined;

    const busy = isPendingRetry ? false : this.isEmployeeBusy(chatId, task.agentName);
    this.update(chatId, taskId, {
      state: busy ? "queued" : "running",
      error: undefined,
      result: undefined,
      question: undefined,
      errorRetries: 0,
      lastError: undefined,
      retryScheduledAt: undefined,
      autoContinues: 0,
    });
    return { task, startNow: !busy };
  }

  /** 取消任务（queued/running/waiting_user 均可）；返回被取消的任务 */
  cancel(chatId: string, taskId: string): Task | undefined {
    const task = this.get(chatId, taskId);
    if (!task || TERMINAL_STATES.includes(task.state)) return undefined;
    this.setState(chatId, taskId, "cancelled");
    return task;
  }

  /**
   * 某员工空闲后，取该员工队列里最早的**可开跑** queued 任务并置为 running。
   * 返回被出队的任务（无则 undefined）。
   *
   * 「可开跑」这道筛子是必需的：等前置的任务同样是 queued，若不跳过，员工一空出来
   * 就会被这里用**原简报**抢跑——交接决策给出的改写/挂起/取消全部落空且重复派发。
   */
  dequeueNext(chatId: string, agentName: string): Task | undefined {
    if (this.isEmployeeBusy(chatId, agentName)) return undefined;
    const next = this.tasks(chatId)
      .filter((t) => t.agentName === agentName && t.state === "queued" && this.startable(t))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return undefined;
    this.setState(chatId, next.id, "running");
    return next;
  }
}

export const taskManager = new TaskManager();
