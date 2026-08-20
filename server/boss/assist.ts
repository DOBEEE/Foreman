import { employeeDisplayName } from "./persona.js";
import { bossThink } from "./think.js";
import type { BaseAgent } from "../agents/base-agent.js";

/**
 * boss 自主协调：员工卡住时，先让 boss 用自己手上的信息处理，处理不了才转人。
 *
 * 为什么该有这一层：boss 握着员工没有的东西——用户原话、派工简报、同一会话里
 * 历史任务的结论、团队名册。员工问「用哪个仓库」而用户第一句就给了地址时，
 * 把问题原样透传给用户是纯粹的浪费。
 *
 * 但代答的危害不是「答不出」而是「编」：boss 凭空给员工一个答案，比问用户更糟——
 * 用户根本不知道方向已经偏了。所以本模块的铁律是**能引用才能答**：
 * 模型必须给出 basis（依据出自哪句话），basis 空或无效一律降级为转人，
 * 这条由代码强制（见 sanitize），不依赖提示词自觉。
 */

/** 分诊结论 */
export type AssistDecision =
  | { kind: "answer"; content: string; basis: string }
  | { kind: "reassign"; agentName: string; reason: string }
  /** 无人可派 → 现招一个只读临时工来做（boss 自己没有动手能力） */
  | {
      kind: "hire";
      capability: string;
      description: string;
      systemPrompt: string;
      /** 要动手才填；含高权限工具时 readRoots 必填，否则 hireTempWorker 会拒 */
      tools?: string[];
      readRoots?: string[];
      reason: string;
    }
  | { kind: "escalate"; reason?: string };

/**
 * 禁止代答的红线：命中即直接转人，连 LLM 都不问（省一次调用，也不给它犯错的机会）。
 * 判据是「这个决定的后果由谁承担」——凡是花钱、动权限、对外可见、不可逆的，
 * 都必须由用户本人拍板，boss 猜对了也不算对。
 */
const NEVER_SELF_ANSWER = [
  /密码|口令|凭据|凭证|token|密钥|secret|api[\s_-]?key|授权码/i,
  /权限|账号|登录|sudo|root/i,
  /删除|清空|覆盖|重置|回滚|drop\s|truncate|rm\s+-rf/i,
  /上线|发布|部署|推送到|push.*(main|master)|合并到|merge.*(main|master)/i,
  /发给|通知|群发|邮件|对外|客户/i,
  /费用|付费|收费|预算|花钱|多少钱/i,
];

/** 问题是否触碰红线（只能由用户决定） */
export function mustAskUser(question: string): boolean {
  return NEVER_SELF_ANSWER.some((re) => re.test(question));
}

interface TriageContext {
  /** 用户原话（任务 prompt） */
  userRequest: string;
  /** 派工简报 */
  brief?: string;
  /** 同一会话里已完成任务的结论摘要 */
  history?: string;
  /** 当前承接员工的路由名 */
  currentAgent: string;
  /** 可改派的候选（已排除试过的人） */
  candidates: BaseAgent[];
  /** 决策日志归属（看板据此把主管的裁决挂到这条任务的时间线上） */
  chatId?: string;
  taskId?: string;
}

/** 从模型输出里抽第一个 JSON 对象 */
function parseJson(out: string): Record<string, unknown> | undefined {
  const raw = out.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * 把模型输出收敛成可信的 AssistDecision。护栏在这里，不在提示词里：
 * - answer 必须同时有非空 content 与非空 basis，否则降级 escalate
 * - reassign 的 agentName 必须是真实候选，否则降级 escalate
 */
function sanitize(
  parsed: Record<string, unknown> | undefined,
  candidates: BaseAgent[],
  allowHire = false,
): AssistDecision {
  const kind = typeof parsed?.kind === "string" ? parsed.kind : "";
  if (kind === "answer") {
    const content = typeof parsed?.content === "string" ? parsed.content.trim() : "";
    const basis = typeof parsed?.basis === "string" ? parsed.basis.trim() : "";
    // 无依据的答案就是编的，一律不要
    if (!content || !basis) {
      return { kind: "escalate", reason: "boss 给不出有依据的答案" };
    }
    return { kind: "answer", content, basis };
  }
  if (kind === "reassign") {
    const agentName = typeof parsed?.agentName === "string" ? parsed.agentName : "";
    if (!candidates.some((c) => c.name === agentName)) {
      return { kind: "escalate", reason: "boss 找不到更合适的同事" };
    }
    const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";
    return { kind: "reassign", agentName, reason: reason || "换更对口的同事来做" };
  }
  if (kind === "hire") {
    // allowHire 由调用方按确定性证据给出（无候选 / 改派额度用尽）。
    // 模型只能「提议」招人，能不能招由代码判——否则它会为了不认输而招人。
    if (!allowHire) return { kind: "escalate", reason: "还有对口同事可试，不该现在招人" };
    const capability = typeof parsed?.capability === "string" ? parsed.capability.trim() : "";
    const description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
    const systemPrompt = typeof parsed?.systemPrompt === "string" ? parsed.systemPrompt.trim() : "";
    if (!capability || !description || !systemPrompt) {
      return { kind: "escalate", reason: "boss 没能给出完整的临时工岗位设计" };
    }
    const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
    const tools = strArr(parsed?.tools);
    const readRoots = strArr(parsed?.readRoots);
    return {
      kind: "hire",
      capability,
      description,
      systemPrompt,
      ...(tools.length ? { tools } : {}),
      ...(readRoots.length ? { readRoots } : {}),
      reason: reason || "无人可派，现招临时工",
    };
  }
  const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : undefined;
  return { kind: "escalate", ...(reason ? { reason } : {}) };
}

/** 轻量 LLM 调用（与路由/验收同档，单轮无工具），顺带落一条主管决策记录 */
async function ask(prompt: string, summary: string, ctx: TriageContext): Promise<string> {
  const { text } = await bossThink({
    kind: "assist",
    summary,
    prompt,
    agentName: ctx.currentAgent,
    ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
  });
  return text;
}

function contextBlock(ctx: TriageContext): string {
  return [
    `## 用户原话（最权威的依据）\n${ctx.userRequest}`,
    ctx.brief ? `## 你当初给的派工简报\n${ctx.brief}` : "",
    ctx.history ? `## 本会话已完成任务的结论\n${ctx.history}` : "",
    ctx.candidates.length
      ? `## 可改派的同事（未接手过本任务的）\n${ctx.candidates
          .map((a) => `- ${employeeDisplayName(a.name)}（路由名 ${a.name}）：${a.routeHint ?? a.description}`)
          .join("\n")}`
      : "## 可改派的同事\n（没有其他候选）",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 员工提问 → boss 先试着自己回答。
 * 三种出口：answer（有依据地代答）/ reassign（其实该换人做）/ escalate（必须问用户）。
 */
export async function triageQuestion(
  question: string,
  ctx: TriageContext,
): Promise<AssistDecision> {
  // 红线问题不进模型，直接转人
  if (mustAskUser(question)) {
    return { kind: "escalate", reason: "涉及权限/凭据/不可逆或对外动作，必须用户本人决定" };
  }
  const prompt = [
    `你是团队主管。你的同事「${employeeDisplayName(ctx.currentAgent)}」在执行任务时停下来提了个问题。`,
    "在把问题转给用户之前，先判断**你自己能不能处理**——用户已经说过的事情不该再问他一遍。",
    "",
    contextBlock(ctx),
    "",
    `## 同事的问题\n${question}`,
    "",
    "## 你的选择（三选一）",
    "- **answer**：上面的材料里**已经有答案**（用户原话/简报/历史结论里明确写着）→ 代替用户回答。",
    "  必须填 basis：指明依据是哪一句原文（照抄那句话的关键片段）。**编不出依据就不要选 answer**。",
    "- **reassign**：问题暴露的是「派错人了/他没这个能力」，换个对口的同事能直接做 → 填 agentName（路由名）。",
    "- **escalate**：这是**产品/方向取舍**，或材料里确实没有答案 → 转给用户。拿不准就选这个。",
    "",
    "## 判断纪律",
    "- **宁可转人，不可编造**：答案必须能在上面材料里指出出处，凭常识补的、推测的、'一般来说'的，都算编造。",
    "- 问题问的是「你想要 A 还是 B」这种取舍偏好 → 一律 escalate，哪怕你觉得 A 明显更好。",
    "- 问题问的是「缺某个具体信息」（路径/地址/分支/文件名/环境）且材料里有 → answer。",
    "- answer 的 content 直接写成对同事说的话，简短、只给结论与必要信息，不要寒暄。",
    "",
    '只输出 JSON：{"kind":"answer","content":"...","basis":"..."} 或 {"kind":"reassign","agentName":"...","reason":"..."} 或 {"kind":"escalate","reason":"..."}',
  ].join("\n");

  try {
    const out = await ask(prompt, `员工提问裁决：${question.replace(/\s+/g, " ").slice(0, 50)}`, ctx);
    return sanitize(parseJson(out), ctx.candidates);
  } catch (error) {
    console.warn("[assist] 提问分诊失败，转人处理:", error);
    return { kind: "escalate", reason: "分诊调用异常" };
  }
}

/**
 * 员工判定做不到（cannot_complete / 验收未通过）→ boss 先试改派，改不了就现招临时工。
 *
 * 三种出口。「代答」在这里没有意义——缺的是能力不是信息，给个答案也做不成。
 * allowHire 由调用方按**确定性证据**给出（无候选 / 改派额度用尽），不由模型自己说了算：
 * 否则它会为了不认输而招人，把「换个人试试」变成「造个人试试」。
 */
export async function triageCapabilityGap(
  report: string,
  ctx: TriageContext,
  allowHire = false,
): Promise<AssistDecision> {
  // 注意：这里**不再**因「没有其他候选」直接 escalate——那恰恰是最该招人的情形
  if (ctx.candidates.length === 0 && !allowHire) {
    return { kind: "escalate", reason: "没有其他可接手的同事" };
  }
  const prompt = [
    `你是团队主管。同事「${employeeDisplayName(ctx.currentAgent)}」报告这个任务他做不成。`,
    allowHire
      ? "判断这是**派错人**（换个同事能做）、**团队里确实没人会**（现招一个临时工来做），还是**任务本身需要用户介入**。"
      : "判断这是**派错人**（换个同事能做）还是**任务本身需要用户介入**。",
    "",
    contextBlock(ctx),
    "",
    `## 他的说明\n${report}`,
    "",
    allowHire ? "## 你的选择（三选一）" : "## 你的选择（二选一）",
    "- **reassign**：他做不成的原因是职责/能力不对口，而名册里有人明显能做 → 填 agentName（路由名）+ reason。",
    allowHire
      ? [
          "- **hire**：团队里**确实没有对口的人** → 现招一个一次性临时工。",
          "  需要填 capability（**能力域**，不是这一次的活：如「接口定义类文档的检索与汇总」）+ description（一句话职责）+ systemPrompt（面向能力域写，别把这次的路径/文件名焊进去；他看不到你和用户的对话，别假设他知道背景）+ reason。",
          '  纯查阅类不填 tools（默认只读）；要改文件/跑命令则 tools 填 ["Write","Edit","Bash"] 之类，**并且必须填 readRoots**（这次要碰哪些目录的绝对路径），否则会被拒。',
          "  他的写入范围恒定为自己的工作目录（改真实仓库要 clone 后 push 工作分支）。只有**多步接力（SOP 型）**招不了 → 选 escalate 并说明该让 hr 正式设计一个岗位。",
        ].join("\n")
      : "",
    "- **escalate**：缺用户才有的信息、需要用户授权、需求本身要改 → 转给用户。",
    "",
    "## 判断纪律",
    "- **别为了改派而改派**：换个人也大概率做不成的，直接 escalate。反复转手比直接说做不到更糟。",
    "- 卡点是「缺信息/缺权限/需求不清」→ 一律 escalate，换人和招人都不解决这类问题。",
    allowHire ? "- **别为了不认输而招人**：招人只解决「没人会这项只读活儿」，不解决需求不清或权限不足。" : "",
    "",
    allowHire
      ? '只输出 JSON：{"kind":"reassign","agentName":"...","reason":"..."} 或 {"kind":"hire","capability":"...","description":"...","systemPrompt":"...","tools":["..."],"readRoots":["..."],"reason":"..."} 或 {"kind":"escalate","reason":"..."}'
      : '只输出 JSON：{"kind":"reassign","agentName":"...","reason":"..."} 或 {"kind":"escalate","reason":"..."}',
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const out = await ask(prompt, "员工报告做不成：判改派/招人/转用户", ctx);
    const decision = sanitize(parseJson(out), ctx.candidates, allowHire);
    // 能力缺口场景不接受 answer：缺的是能力，给答案没用
    return decision.kind === "answer"
      ? { kind: "escalate", reason: "代答无法解决能力缺口" }
      : decision;
  } catch (error) {
    console.warn("[assist] 能力缺口分诊失败，转人处理:", error);
    return { kind: "escalate", reason: "裁决调用异常" };
  }
}
