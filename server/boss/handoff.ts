import { getAgent } from "../agents/registry.js";
import { taskManager as tm } from "./task-manager.js";
import { employeeDisplayName } from "./persona.js";
import { bossThink } from "./think.js";
import { TERMINAL_STATES, type Task, type TaskState } from "./types.js";

/**
 * 串行交接：前置任务干完后，决定它的后继怎么走。
 *
 * 这是「等 A 干完再让 B 开始」的第二半。第一半是数据（`Task.afterTask` + 出队闸门），
 * 保证 B 不会提前跑；这一半是判断，保证 B 拿到的不是一份过时的简报。
 *
 * 为什么用 `bossThink`（单轮、**无工具**、窄上下文）而不是起一次完整的 boss 轮次：
 * - **不会记混**：只喂 A 的诉求/产出/验收结论 + B 的原简报，不喂聊天历史。用户在等待
 *   期间插入多少别的任务都进不来。
 * - **不会乱派**：它手上没有工具，结构上就不可能顺手再建几个任务或形成循环。
 * - 便宜：轻量模型一次调用，不是一整个 agent run。
 */

/** 交接裁决 */
export interface HandoffDecision {
  /** go=照原简报派 / revise=按改写后的简报派 / hold=挂起问用户 / drop=取消后继 */
  action: "go" | "revise" | "hold" | "drop";
  /** revise 时的新简报 */
  brief?: string;
  /** hold 时抛给用户的问题 */
  question?: string;
  /** 判断依据，进日志与播报 */
  reason?: string;
}

/** 决策实现（可替换，测试注入 stub） */
export type HandoffDecider = (input: {
  predecessor: Task;
  successor: Task;
  /** 前置的终态 */
  to: TaskState;
}) => Promise<HandoffDecision>;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把前置的产出确定性拼进后继的简报。
 *
 * 与定时任务的 `then` 同一套做法（见 scheduler 的 dispatchFollowUp）：下游那句
 * 「根据上一步的结果做 X」不给它上一步的结果就是空话。刻意做成确定性拼接而不是让模型
 * 转述——转述会丢路径、丢数字。
 */
export function withUpstreamOutput(brief: string, predecessor: Task): string {
  const upstream = (predecessor.result ?? "").trim();
  if (!upstream) return brief;
  return [
    brief,
    "",
    `【上游任务 #${predecessor.id}「${truncate(predecessor.prompt.replace(/\s+/g, " "), 40)}」的产出（由${employeeDisplayName(predecessor.agentName)}完成，据此执行）】`,
    truncate(upstream, 6000),
  ].join("\n");
}

/**
 * 解析这个任务该由谁验收：任务上的一次性指定优先，其次岗位配置声明的 `reviewer`。
 *
 * 返回 undefined 表示**不派验收员**，降级为「合约硬校验 + 主管协议闸」——这对多数岗位
 * 就是正解（结论类产出没有可独立评审的工件）。
 *
 * 两种降级都必须兜住：
 * - 指向不存在的员工。`code-review` 随 presets 发布而 `default` 是 builtin，没装 presets
 *   的环境这条引用就是悬挂的；用户也可能把评审岗删掉。
 * - 评审人等于执行者。一次性指定走模型填参，绕过了 profile 那道校验。
 */
export function resolveReviewer(task: Task): string | undefined {
  const declared = task.reviewer ?? getAgent(task.agentName)?.profile.reviewer;
  if (!declared) return undefined;
  if (declared === task.agentName) {
    console.warn(`[handoff] 忽略评审人「${declared}」：与执行者相同，自己评自己没有意义`);
    return undefined;
  }
  if (!getAgent(declared)) {
    console.warn(`[handoff] 忽略评审人「${declared}」：这个员工不存在，本次降级为不派验收员`);
    return undefined;
  }
  return declared;
}

/**
 * 默认裁决：轻量模型判「后继还照原计划做吗」。
 *
 * **前置没成功时不问模型，一律 hold。** 理由是失败可以被 `retry_task` 复活：让模型决定
 * 「要不要放弃 B」，一旦它判 drop，A 重试成功后 B 就永久消失了。这种活丢了没人知道，
 * 交回用户手上是唯一安全的做法。
 */
export const defaultHandoffDecider: HandoffDecider = async ({ predecessor, successor, to }) => {
  if (to !== "done") {
    return {
      action: "hold",
      question:
        `任务 ${taskRefOf(successor)} 排在 ${taskRefOf(predecessor)} 后面，但 ${taskRefOf(predecessor)} ` +
        `${to === "failed" ? "失败了" : "被取消了"}。这个后续还要继续做吗？要的话我直接派，不要就说取消。`,
      reason: `前置 ${to}，按纪律交回用户决定（失败可能被重试复活，不能替用户丢活）`,
    };
  }

  const prompt = [
    "你是主管。一个任务刚干完，它后面排着另一个任务。请判断后面这个还照原计划派吗。",
    "",
    `## 已完成的前置任务（#${predecessor.id}，执行人：${employeeDisplayName(predecessor.agentName)}）`,
    `诉求：${truncate(predecessor.prompt, 800)}`,
    predecessor.acceptance ? `验收标准：${truncate(predecessor.acceptance, 300)}` : "",
    `产出：\n${truncate(predecessor.result ?? "（无产出）", 4000)}`,
    "",
    `## 排在它后面的任务（#${successor.id}，执行人：${employeeDisplayName(successor.agentName)}）`,
    `原简报：${truncate(successor.brief ?? successor.prompt, 800)}`,
    "",
    "## 判定",
    "- go：原简报仍然成立，照原样派。**这是默认选择**——没有明确理由就选它。",
    "- revise：原简报里有需要按前置产出订正的地方（如上游给出了具体路径/分支/结论，简报里还写着占位描述）。填 brief 给出改写后的完整简报，格式与原简报一致。",
    "- hold：前置的产出说明这件事的前提变了，**必须由用户拍板**才能继续。填 question。",
    "- drop：前置的产出已经把这件事做掉了，或证明它没必要做了。填 reason。",
    "",
    "纪律：",
    "- 不要因为「想更完善」就 revise —— 只在原简报确实会导致做错时改。",
    "- 不要因为前置产出里有风险提示就 hold —— 风险与遗留不等于前提变了。",
    "- drop 要谨慎：把用户排好的活取消掉，得有产出里的明确证据。",
    "",
    '只输出 JSON：{"action":"go|revise|hold|drop","brief":"...","question":"...","reason":"..."}',
  ]
    .filter(Boolean)
    .join("\n");

  const { text, isError } = await bossThink({
    kind: "handoff",
    summary: `交接：#${predecessor.id} 干完，判 #${successor.id} 怎么走`,
    prompt,
    chatId: successor.chatId,
    taskId: successor.id,
    agentName: successor.agentName,
  });
  if (isError) throw new Error(text || "handoff 调用失败");
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("handoff 输出非 JSON");
  const parsed = JSON.parse(json) as HandoffDecision;
  if (!["go", "revise", "hold", "drop"].includes(parsed.action)) {
    throw new Error(`handoff action 非法：${parsed.action}`);
  }
  if (parsed.action === "revise" && !parsed.brief?.trim()) {
    throw new Error("revise 但没给 brief");
  }
  if (parsed.action === "hold" && !parsed.question?.trim()) {
    throw new Error("hold 但没给 question");
  }
  return parsed;
};

function taskRefOf(task: Task): string {
  return `#${task.id}`;
}

// ─── 编排运行时 ──────────────────────────────────────────────

/**
 * 交接需要的副作用（由 boss 层注入）。
 * 抽成接口是为了让编排逻辑可测：boss.ts 拖着渠道投递、并发闸、runWorker 一整条依赖，
 * 而这里要断言的是「什么情况下放行 / 挂起 / 取消」这套判断，不该被那条链拖住。
 */
export interface HandoffEffects {
  /** 播报给用户 */
  say: (task: Task, text: string) => void;
  /** 放行后推进该员工的队列（由既有机制决定立刻跑还是继续排队） */
  advance: (chatId: string, agentName: string) => void;
  /** 挂起等用户拍板 */
  hold: (task: Task, question: string) => void;
}

let effects: HandoffEffects | undefined;
let decide: HandoffDecider = defaultHandoffDecider;

export function setHandoffRuntime(input: {
  effects: HandoffEffects;
  decider?: HandoffDecider;
}): void {
  effects = input.effects;
  if (input.decider) decide = input.decider;
}

/**
 * 同步给所有等待中的后继打闸。
 *
 * **必须同步**：前置终态的调用链是「改状态 → 播报 → advanceEmployee」同一 tick，
 * 而决策是异步的。不在这一步打上闸，`advanceEmployee` 会先发现依赖已满足、用**原简报**
 * 把后继拉起来，于是改写/挂起/取消全部落空还重复派发。
 */
export function markSuccessorsPending(predecessor: Task): Task[] {
  const successors = tm.successorsOf(predecessor.chatId, predecessor.id);
  for (const s of successors) {
    tm.update(s.chatId, s.id, { handoffPending: true });
  }
  return successors;
}

/** 落地一条裁决 */
function apply(predecessor: Task, successor: Task, decision: HandoffDecision): void {
  const fx = effects;
  if (!fx) {
    console.error("[handoff] 未接线（setHandoffRuntime 没被调用），后继无人放行");
    return;
  }
  const ref = taskRefOf(successor);

  if (decision.action === "drop") {
    tm.update(successor.chatId, successor.id, {
      handoffPending: false,
      handoffResolvedAt: Date.now(),
    });
    tm.cancel(successor.chatId, successor.id);
    fx.say(
      successor,
      `🚫 任务 ${ref} 取消了：${decision.reason ?? `${taskRefOf(predecessor)} 的产出已经覆盖了它`}。`,
    );
    // 等着 successor 的下一级不需要在这里级联取消：cancel 会让它进终态，
    // 下一级的交接按「前置非 done → hold」把选择权交回用户——既不会永久排队，
    // 也不会替用户悄悄把活丢掉。
    return;
  }

  if (decision.action === "hold") {
    tm.update(successor.chatId, successor.id, {
      handoffPending: false,
      handoffResolvedAt: Date.now(),
    });
    fx.hold(successor, decision.question!);
    return;
  }

  // go / revise：清掉依赖并放行。**先落盘再推进**——否则进程在这中间崩掉，
  // 恢复后拿到的是没注入上游产出的旧简报。
  const baseBrief = decision.action === "revise" ? decision.brief! : (successor.brief ?? successor.prompt);
  tm.update(successor.chatId, successor.id, {
    brief: withUpstreamOutput(baseBrief, predecessor),
    afterTask: undefined,
    handoffPending: false,
    handoffResolvedAt: Date.now(),
  });
  fx.say(
    successor,
    `▶️ ${taskRefOf(predecessor)} 收尾了，接着跑 ${ref}` +
      (decision.action === "revise" ? `（简报按上游产出订正过：${decision.reason ?? "见任务详情"}）` : "") +
      "。",
  );
  fx.advance(successor.chatId, successor.agentName);
}

/**
 * 逐个决定后继怎么走。多后继**串行**处理：同员工的多个后继若并行放行会互相排队，
 * 顺序还不确定。
 */
async function resolveHandoff(predecessor: Task, to: TaskState, successors: Task[]): Promise<void> {
  for (const s of successors) {
    const successor = tm.get(s.chatId, s.id);
    // 期间可能被用户手动取消 / 已被别的路径处理掉
    if (!successor || successor.state !== "queued" || !successor.handoffPending) continue;
    let decision: HandoffDecision;
    try {
      decision = await decide({ predecessor, successor, to });
    } catch (error) {
      // 回落 go，不回落 hold：hold 是静默卡死（用户不知道有个任务在等他回话），
      // 而 go + 确定性拼上游产出至少让活继续往下走。
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[handoff] 裁决失败，按原计划放行：${reason}`);
      decision = { action: "go", reason: `裁决环节出错（${reason.slice(0, 120)}），按原简报放行` };
    }
    apply(predecessor, successor, decision);
  }
}

/**
 * 终态钩子入口：同步打闸，异步决策。
 *
 * **不要在这里取 chat 锁**：`withChatLock` 不可重入，而 `cancel_task` 这类 boss 工具
 * 本身就跑在那把锁里，一取就死锁。
 */
export function onTaskTerminal(predecessor: Task, to: TaskState): void {
  const successors = markSuccessorsPending(predecessor);
  if (successors.length === 0) return;
  void resolveHandoff(predecessor, to, successors);
}

/**
 * 重启后补交接。返回补触发的条数。
 *
 * 必须有：宕机期间前置可能已经跑到终态，而那次终态钩子随进程一起没了，后继就会永久
 * 停在 queued —— 这是这套编排最容易出现的静默失效（没人报错，活就是不动了）。
 * 残留的 `handoffPending` 也必须清：给它打闸的那个决策进程已经不在了，不清就永远开不了。
 */
export function recoverPendingHandoffs(): number {
  let recovered = 0;
  for (const task of tm.allActiveTasks()) {
    if (task.state !== "queued" || !task.afterTask) continue;
    if (task.handoffPending) {
      tm.update(task.chatId, task.id, { handoffPending: false });
    }
    if (task.handoffResolvedAt) continue; // 已经决策过，不重复
    const dep = tm.get(task.chatId, task.afterTask);
    if (!dep || !TERMINAL_STATES.includes(dep.state)) continue;
    console.log(`[handoff] 重启补交接：#${dep.id} 已收尾，重新决定 #${task.id} 怎么走`);
    onTaskTerminal(dep, dep.state);
    recovered++;
  }
  return recovered;
}
