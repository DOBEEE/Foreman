/** Boss 任务模型：确定性状态由代码维护，不放 LLM 上下文 */

import type { Contract } from "../core/contract.js";
import type { TaskReport } from "../tools/task-report.js";
import type { RuntimeKind } from "../runtime/types.js";

export type TaskState =
  | "queued" // 员工忙，排队等待派发
  | "running" // 员工正在执行
  | "waiting_user" // 员工暂停，等用户回答问题（仍占用员工）
  | "done"
  | "failed"
  | "cancelled";

/** 员工占用态：running / waiting_user 都占用员工，不能接新任务 */
export const OCCUPYING_STATES: TaskState[] = ["running", "waiting_user"];

/**
 * 终态：不会再变了。依赖闸门（前置算不算「结束」）与交接钩子都以此为准，
 * 抽成常量是因为这个字面量原先散在十余处，判定语义一漂就会出现「等一个永远等不到的前置」。
 */
export const TERMINAL_STATES: TaskState[] = ["done", "failed", "cancelled"];

export interface Task {
  id: string; // 短 id，用户用 #id 引用
  channel: string;
  chatId: string;
  chatType: "private" | "group";
  /** 发起人：群里确认问题需 @ 此人 */
  ownerSenderId: string;
  ownerSenderName: string;
  /** 承接的员工（垂直 agent 名） */
  agentName: string;
  /**
   * 由定时任务派发（非用户直接要求）。
   *
   * 为什么要标：定时任务的结论也要投递到用户会话（如 RETRO_NOTIFY_USER 指向某个私聊），
   * 于是它们与用户任务落在同一个 chatId 的任务库里。复盘这类每天都跑的任务会把
   * 「最近收尾」前几名全占满，boss 再回答「上次没执行完成的任务」时只看得到复盘任务，
   * 就会答出与用户诉求完全不相干的东西（真实事故：用户要续跑，boss 讲了一通 API 计费额度）。
   * 所以喂给 LLM 的快照默认排除它们，需要时仍可通过 list_tasks / get_task_detail 查到。
   */
  scheduled?: boolean;
  /** 任务原始描述 */
  prompt: string;
  /** 主管派工简报（分诊时提炼的目标/关键信息/验收标准），派发给员工时与原话一并下发 */
  brief?: string;
  state: TaskState;
  /** 员工会话 id，回答后 resume 续跑 */
  sessionId?: string;
  /**
   * 产出 `sessionId` 的 runtime。缺失 = 切 runtime 之前写的老任务，按异源处理。
   *
   * 为什么必须记：sessionId 是 runtime 私有的（Vercel 存 `<runtimeDir>/sessions/`，
   * Qoder 存 `~/.qoder/projects/<项目>/`）。把 A 的 id 递给 B 会**致命失败**——
   * 实测 Qoder worker 直接 exit 42（`Invalid session identifier`），且脏 id 留在库里
   * 会让此后每一轮都重复失败。判定统一走 `resumableSessionId()`。
   */
  sessionRuntime?: RuntimeKind;
  /** 因步数用满自动续跑的次数（受 config.maxAutoContinues 约束，防绕圈任务无限续） */
  autoContinues?: number;
  /** boss 代替用户回答员工提问的次数（受 config.assist.maxSelfAnswers 约束，防它一直自作主张） */
  bossAssists?: number;
  /** 改派次数（受 config.assist.maxReassigns 约束，防 A→B→C 无限转手） */
  reassigns?: number;
  /** 验收不通过后追问员工的轮次（受 config.assist.maxReviewRetries 约束，防反复返工烧 token） */
  reviewRounds?: number;
  /**
   * 因进程中断而被重新派发的次数。进程反复重启（如 watch 模式跟随代码改动）时，
   * 同一任务会被一轮轮重跑且永远跑不完，超过上限即判失败，避免无谓烧 token。
   */
  recoverCount?: number;
  /** 模型网关/网络瞬态错误的同任务自动重试次数。 */
  errorRetries?: number;
  /** 最近一次瞬态错误，供重启恢复与任务详情展示。 */
  lastError?: string;
  /** 正在等自动重试的计划执行时间（ms）。非 undefined = state 虽是 running 但实际没有 LLM 在跑 */
  retryScheduledAt?: number;
  /** 接手过本任务的员工（含当前），改派时排除，避免转回已经失败的人 */
  triedAgents?: string[];
  /** waiting_user 时的待确认问题原文（每次消息/状态变更可重播） */
  question?: string;
  /**
   * 澄清占位任务：路由不确定时先挂起等用户定向，从未真正派发过任何员工。
   * 收到答复后要「合并原诉求 + 重新路由」——这是唯一合法的「答复→重路由」场景。
   * 一旦成功派发即清除（此后它是正常在办任务，答复应回到它自己的员工，而不是重路由）。
   *
   * 为什么要显式标记而不复用 `!sessionId`：像 retro 这类岗位跑子会话时 persistSession:false，
   * 任务从来不带 sessionId，用「无 session」判占位会把真跑过的复盘任务误判成占位，
   * 于是答复被重路由到别的岗位（且候选池排除了 manualOnly 的 retro），永远回不到复盘员。
   */
  awaitingClarifyRoute?: boolean;
  /** 完成/失败的结论 */
  result?: string;
  error?: string;
  /**
   * 交卷（`report_task_done`）的结构化入参。
   *
   * 为什么除了渲染后的 `result` 还要留一份结构：工作台索引要按字段单独取
   * （conclusion 压一行、decisions 单列、risks 判「无」则不显示），而 `result` 是
   * 拼给用户看的 markdown——从里面反解析字段是脆的，格式一改就静默失准。
   */
  report?: TaskReport;

  // ─── 编排：等另一个任务干完再开始 ────────────────────────────
  /**
   * 前置任务 id（同 chat 内）：本任务要等它到终态才开始。
   *
   * 为什么不新增 `blocked` 状态而是复用 `queued`：全代码库有十余处按状态白名单判定，
   * 其中 `scheduler.ts` 的单实例约束与 `api/http.ts` 的 SSE 收尾会**静默变坏**（不报错、
   * 逻辑错），前端 4 处按状态穷举渲染会静默丢数据。而 `activeTasks` 系列是黑名单式
   * （`!["done","failed","cancelled"]`），复用 queued 时自动正确。用户视角两者也一致：
   * 都是「还没开始」，只是等的东西不同（等员工空 vs 等前置）。
   *
   * **编排关系是数据，不是 boss 的记忆。** boss 只在派工那一刻写一次，之后由代码执行；
   * 用户在等待期间插入多少别的任务、说多少别的话都不影响它。
   */
  afterTask?: string;
  /**
   * 交接决策进行中的闸。
   *
   * 必须有：前置终态的代码路径是「改状态 → 播报 → advanceEmployee」同一 tick，而交接
   * 决策是异步的。不打这个闸，`advanceEmployee` 会先发现依赖已满足、用**原简报**把本任务
   * 拉起来，于是决策给出的改写/挂起/取消全部落空，还会重复派发。
   */
  handoffPending?: boolean;
  /**
   * 交接决策完成的时刻（留痕，必须落盘）。
   *
   * 真正的幂等靠「放行时清掉 `afterTask`」——清掉后 `successorsOf` 再也找不到它。
   * 这个字段是留痕加二次保护：同一个前置的终态事件会来第二次（验收返工会让任务多次
   * 进出 running，`retryFailed` 也会重放终态），scheduler 已经因为缺这类幂等位栽过
   * （见 `schedule-store.ts` 的 `lastAccountedTaskId`）。
   */
  handoffResolvedAt?: number;

  // ─── 验收 ────────────────────────────────────────────────
  /**
   * 验收标准（派工时由 boss 明确）。
   * 与 `brief` 里那句「验收：…」的区别：这里是**结构化留存**，验收环节会把它作为独立
   * 段落要求逐条核对；写在 brief 自由文本里时，裁决者只是顺带看到，没人拿它当依据。
   */
  acceptance?: string;
  /**
   * 可机验的产出合约（文件/字段），复用 `core/contract.ts` 的形状。
   * 有它就先做零模型硬查：员工说「已写入 xxx.md」而文件不在，直接判未完成——
   * 这类事不该交给单轮无工具的文本判断去猜。
   */
  contract?: Contract;
  /**
   * 本次指定的验收员（一次性覆盖，不写进 profile）。
   * 缺省时读岗位配置的 `reviewer`；两者都没有就降级到硬校验 + 协议闸，不派验收员。
   */
  reviewer?: string;

  createdAt: number;
  updatedAt: number;
}

/**
 * 可用于 resume 的会话 id —— **所有 resume 判定的唯一出口**。
 *
 * 只有「产出它的 runtime」与当前 runtime 一致才认。异源或无归属（切 runtime 之前的老任务）
 * 一律返回 undefined，让调用方开一个干净会话。
 *
 * 不这么做的后果是实测过的线上故障：boss 拿 Vercel 时代的 id 去 Qoder resume，
 * worker 直接 exit 42（`Invalid session identifier`），而脏 id 一直留在任务库里，
 * 于是**每一轮都失败**。判定收在一个函数里，避免各调用点各写一遍、漏一处就复发。
 */
export function resumableSessionId(
  task: Pick<Task, "sessionId" | "sessionRuntime">,
  currentRuntime: RuntimeKind,
): string | undefined {
  if (!task.sessionId) return undefined;
  return task.sessionRuntime === currentRuntime ? task.sessionId : undefined;
}
