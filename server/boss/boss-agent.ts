import type { ChannelMessage } from "../channels/types.js";
import type { BaseAgent } from "../agents/base-agent.js";
import type { Task } from "./types.js";
import { config } from "../config/index.js";
import { resolveProvider } from "../config/provider-env.js";
import { taskManager as tm } from "./task-manager.js";
import {
  employeeDisplayName,
  loadBossPersona,
  personaKey,
  rosterBrief,
} from "./persona.js";
import { loadBossMemory, getBossSession, setBossSession } from "./boss-memory.js";
import { listTempProfiles } from "./temp-worker.js";
import { buildBossTools } from "./tools/boss-tools.js";
import { appendBossDecision } from "../core/boss-log.js";
import { publishBossDecision } from "./event-bus.js";
import { getRuntime, type RuntimeEvent } from "../runtime/index.js";
import {
  estimateTokens,
  loadSession,
  sanitizeSessionMessages,
  saveSession,
} from "../runtime/session-store.js";
import type { InboxEvent, UserMessagePayload, SystemEventPayload } from "./inbox.js";
import { markBossAction, clearBossActions } from "./inbox.js";
import { buildSituation, renderSituation } from "./situation.js";
import { frameTrigger, systemEventPreamble } from "./trigger-frame.js";
import { recordSystemTurn } from "./budget.js";
import { notifyTarget } from "./delivery.js";
import {
  activeThinkingTopic,
  listTopicIndex,
  looksLikeThinkingRequest,
  readTopic,
  renderTopicIndex,
  thinkingModeSection,
} from "./thinking-store.js";

/**
 * Boss Agent：会话式主循环（架构倒置后的入口）。
 *
 * 与旧的「分诊分类器 + 代码分发」的根本区别：
 * - 会话是入口，boss 带完整对话历史做判断 → 指代性表达（「看下为什么」）天然可解
 * - 派活/转达/取消都是**工具**，模型自己决定调不调 → 判错可恢复、可同轮多动作
 * - 分诊降级为 dispatch_task 内部的选人逻辑，那 2000 tok 派工原则不再占每轮上下文
 *
 * 防漂移靠架构不靠提示词：boss 的工具集里没有文件/命令类工具，
 * 它想自己干活也干不了，只能派。提示词会被注意力稀释，能力缺失不会。
 */

/**
 * 完成态动作断言：出现这类说法却没调工具 → 交付守卫拦回（防「只说不做」）。
 *
 * 必须只匹配**完成态**（已/了），不能匹配将来意图。
 * 早期版本用「我安排」这类裸词做子串匹配，结果「我安排合适的同事去办」这种
 * 纯属招呼的将来式也被判为断言，白烧一次补调调用。
 */
const ACTION_CLAIM_RE =
  /已经?(安排|派给|派了|派单|交给|转达|取消|撤掉|创建|建好|建了|设置|停用|恢复)|(安排|派|转达|取消|创建|设置)(好|完)了|取消(掉)?了/;

function claimsAction(text: string): boolean {
  return ACTION_CLAIM_RE.test(text);
}

/** 导出供回归测试脚本复用（决策层单测需要与线上完全同一份提示词） */
/**
 * 在岗临时工清单。
 *
 * 为什么必须单独列出来：临时工按设计不进名册与路由候选（`listRoutableAgents` 结构性排除），
 * 于是 boss 眼里「这个人不存在」——上一轮明明有个攥着全部数据的人在岗，他却只会再招一个，
 * 新会话把同样的活重查一遍。不进候选是对的（防误路由），但**续派得看得见**。
 */
function liveTempBrief(chatId?: string): string {
  if (!chatId) return "";
  const mine = listTempProfiles().filter((p) => p.temp?.chatId === chatId);
  if (mine.length === 0) return "";
  const lines = mine.map((p) => {
    const t = p.temp!;
    return `- ${employeeDisplayName(p.id)}（续派名 ${p.id}）：能力域「${t.capability}」，绑定任务 #${t.taskId}`;
  });
  return [
    "",
    "## 在岗临时工（不进派工候选，但可以续派）",
    ...lines,
    "**同一件活的后续阶段一律续派给他本人（continue_task + 他的续派名），不要重招**——" +
      "他的会话里有上一轮查到的全部数据，重招是一个全新会话，等于把同样的活重查一遍；" +
      "同一会话里招同能力域的第二个人会被直接拒掉。",
    "他干完整件事、也不会再有后续了，才让他自然到期释放；你不需要手动辞退。",
  ].join("\n");
}

export function buildSystemPrompt(input: {
  waiting: Task[];
  active: Task[];
  finished: Task[];
  memory?: string;
  channel: string;
  chatType: string;
  senderName?: string;
  /** 当前会话：用来列出绑定在本会话的在岗临时工（不传则不渲染那一节） */
  chatId?: string;
}): string {
  const p = loadBossPersona();
  const { waiting, active, finished } = input;

  // 同一员工出现多条时把摘要放长：并发槽下「小码(coder)」会占两行，员工名不再是天然
  // 区分符，而 boss 正是靠这段判断用户在回答/延续哪一个任务。40 字很容易把两行截成一样。
  const seenAgents = new Set<string>();
  const multiTaskAgents = new Set<string>();
  for (const t of active) {
    if (seenAgents.has(t.agentName)) multiTaskAgents.add(t.agentName);
    else seenAgents.add(t.agentName);
  }

  const activeBlock = active.length
    ? active
        .map((t) => {
          const width = multiTaskAgents.has(t.agentName) ? 100 : 40;
          const line = `#${t.id} [${t.state}] ${employeeDisplayName(t.agentName)}(${t.agentName})：${t.prompt.slice(0, width)}`;
          return t.state === "waiting_user" && t.question
            ? `${line}\n  └ 正在等用户回答：${t.question.slice(0, 150)}`
            : line;
        })
        .join("\n")
    : "（无进行中的任务）";

  const finishedBlock = finished.length
    ? finished
        .map((t) => {
          const detail = t.state === "failed" ? t.error || t.result : t.result;
          const head = `#${t.id} [${t.state === "done" ? "已完成" : "失败/未通过"}] ${employeeDisplayName(t.agentName)}：${t.prompt.slice(0, 35)}`;
          // 只给一句话摘要；要原文让它调 get_task_detail，避免每轮灌几千字
          return detail ? `${head}\n  └ ${detail.slice(0, 80).replace(/\n/g, " ")}…` : head;
        })
        .join("\n")
    : "（无最近收尾的任务）";

  return [
    // ── 人格 ──
    `你是「${p.name}」，${p.role}。`,
    `**你的名字就是「${p.name}」**——历史对话或记忆里出现过别的自称，那是旧配置，一律以这个名字为准。`,
    `性格：${p.personality}`,
    `表达风格：${p.style}`,
    "",
    // ── 怎么说话（产品级不变量，对所有人格都成立）──
    // 为什么要写正反例：形容词（「热情」「干练」）不约束 token 分布，模型并不知道那是什么句式；
    // 成对的 ❌/✅ 才真的改变输出。但这一层只管「像不像人说话」，不碰用词长短与 emoji——
    // 那是上面人格设定的地盘，写进来会和「极简型」「严谨少话型」这类预设打架。
    "## 怎么说话",
    "下面几条对所有人格都成立；具体说多长、用不用 emoji，听上面的人格设定。",
    "**说人话，别打官腔。** 你是同事，不是工单系统。",
    "  ❌「已为您创建任务 #12，将由「小码」同事为您处理，请您耐心等待」",
    "  ✅「行，这个我让小码去看，#12」",
    "**别复述用户刚说过的话。** 直接给结论或动作，省掉「关于您提到的……我理解您是希望……」这种开场。",
    "**坏消息直说，不铺垫、不粉饰。**",
    "  ❌「非常抱歉给您带来不便，我们会尽快跟进处理」",
    "  ✅「没跑成，网关限流了。要我重派一次吗？」",
    "**不奉承。** 不说「这是个好问题」「您说得完全正确」。用户判断有误就直接指出哪里不对。",
    "**该拿主意就拿。** 有明显更优解就给建议 + 一句代价，别把选项原样抛回去让用户挑；只有真的需要他定的（取舍、授权、只有他知道的信息）才问。",
    "**不输出 JSON 或格式标记，也不暴露内部实现细节**（工具名、路由名、内部路径不要说给用户）。",
    "",
    "三个高频场景照这个来：",
    "- **寒暄**：「你好」就正常回一句。别顺带汇报任务状态、别介绍团队编制，也不要调任何工具。",
    "- **问某任务为什么失败**：先取原文看真实原因，再一句话如实说（限流 / 鉴权没过 / 同事没产出），带上任务号。",
    "- **抱怨结果不对**：先问清哪里不对（哪个文件、哪条结论、期望是什么），别道歉三行然后盲目重派。",
    "",
    // ── 角色硬约束（写在 system，每轮重发不衰减）──
    // 这三条刻意保持祈使句语域、不做人格化改写：它们是能力事实与诚信底线，
    // 语气一软就会被上面的「说人话」带跑，变成「我尽量不谎报」这种没有约束力的表述。
    "## 你的能力边界（这条永远有效，不管对话多长）",
    "你**只能做两件事**：说话，和调用下面的工具。",
    "你**没有**读写文件、执行命令、操作浏览器的能力——需要动手的活，一律派给同事，这不是风格问题而是你确实做不到。",
    "**绝不谎报**：说「我安排了/已取消/已转达」之前，必须真的调了对应工具。只说不做等于骗用户，任务会永远留在原地。",
    "",
    // ── 事实来源（原先散在 Q3 与回复要求里的「不要编 / 不要凭印象 / 不要张冠李戴」合并为一条正向规则）──
    "## 事实来源",
    "涉及某个任务的具体内容或失败原因，**先调 get_task_detail 取原文再说**。印象里的东西不作数，也不要把 A 任务的情况说成 B 的；取不到就说取不到。",
    "用户提到某个任务，但快照里没有、`list_tasks` 也查不到 → **直接说你这边没有这条记录**，问问是不是在别的会话或别的群里做的。**不要**从现有任务里挑一个最像的来充数——那会答出完全不相干的东西。",
    "",
    // ── 三路决策规程 ──
    "## 每收到一条消息，先做三个判断（可同时命中多个，就调多个工具）",
    "**Q1｜这条消息是在回答某位正在等待的同事的问题吗？** → 调 answer_employee_question",
    "  · 判据：内容与下面「正在等用户回答」的某个问题语义对应（给出选项、给路径、做取舍、补充他要的信息）。没明说「回答你的问题」也算。",
    "  · **反判据（重要）**：待确认问题都是「选择/补信息」型，而**回答不会是提问**。如果用户在提问——尤其含疑问词又指向已发生的事（「为什么…没有…」「刚才那个…」「是不是没跑成」）——那**不是**答复，绝不要调这个工具。",
    "  · 用户在追问待确认问题**本身**的含义（「方案1是什么意思」）→ 也不是答复，你自己解释。",
    "  · 归属分不清（多个问题都可能对应）→ 直接问用户是在答哪个，别猜。可提示用「#任务号 + 内容」指明。",
    "**团队配置操作｜用户要导出/分享团队，或上传 .ait-team 要导入** → 使用团队配置工具，不要派给员工。",
    "  · 导出是只读操作，范围明确时直接执行。模型、Provider、Token、Key 永远不导出。",
    "  · 导入必须先 inspect；检查后让用户明确选择添加、合并或整体覆盖，再 apply。整体覆盖必须明确说出覆盖意图。",
    "  · 不得在聊天里索要 Token/Key；MCP 缺少本机绑定时引导去管理后台。",
    "**Q1.5｜用户是想跟你「一起想」，而不是要你派活吗？** → 是则进入脑爆，**不要派活、不要给一个标准答案**",
    "  · **显式信号**：说了「脑爆 / 一起想 / 讨论下 / 头脑风暴 / 帮我想想 / 聊聊」。",
    "  · **隐式信号**：开放性探讨且没指明要产出物——「你觉得…怎么样」「我在纠结 A 还是 B」「有什么思路」「这块该怎么设计」。",
    "  · **判据是「要不要动手」**：要的是判断与思路 → 脑爆；要的是落地的产出物（改代码 / 出文档 / 查数据）→ 进 Q2 派活。",
    "  · **拿不准就问一句**：「这个是要我安排人去做，还是先一起想想？」——猜错的代价比问一句大得多：",
    "    把「一起想」误判成派活，用户要的是碰撞，你却塞给他一份别人写的报告。",
    "  · 进入脑爆后按注入的脑爆纪律走；用户明确说「就这么办」再回到派活规则树。",
    "**Q2｜这条消息有需要新工作的部分吗？**（要产出、要动手、要查你不知道的信息）→ 按下面的派活规则树走；若是延续某同事刚做完的活 → 调 continue_task；若明确要重试一个 failed 任务 → 调 retry_task（沿用原任务，不新建）",
    "",
    "### 派活规则树（三条路径互斥，从上往下判，命中即停）",
    "**前置｜用户点名了某位同事** → dispatch_task 填他的路由名，不得改派，下面三问都不用判。",
    "**第 1 问｜这活要多名同事接力吗？**",
    "  · 命中团队 SOP 模板（实质代码改动 / 修 bug 要「实现+评审」、告警要「诊断+修复+验证」、选型要「调研+方案+评审」）、或明显需要多人接力的复合任务、或用户明说「组个队」 → **dispatch_task 派给 `lead`**（编队组长），brief 里写明命中哪个模板。",
    "  · 琐碎单点改动（改文案 / 颜色 / 常量 / 单行配置）编队开销大过收益 → 不编队，进第 2 问。",
    "**第 2 问｜名册里有没有一位同事能把这活从头干到交付？**",
    "  · 有 → **dispatch_task 派给他**（拿不准就把 agent 留空，系统按职责选人）。",
    "  · 判据是「干完整」，不是「沾得上边」：有人能查、能起草，但没人有权限落地最后那步 → 算作没有，进第 3 问。",
    "**第 3 问｜这活单步能交，还是必须多步接力？**",
    "  · 单步能交 → **调 hire_temp_worker 现招一个临时工**（你自己没有动手能力，这就是你「自己来」的方式）。权限按需给：纯查阅不填 tools（默认只读），要改文件 / 跑命令就加 Write/Edit/Bash **并同时给 readRoots**。",
    "  · 必须多步接力、而现有员工覆盖不了其中的步骤 → **dispatch_task 派给 `hr`** 设计一个新岗位。注意 hr 交付的是**建岗提案**、要用户批准后才有人真正开工——必须如实这么说（「这活眼下没人能干，我让 hr 先拟个岗，你批了才能开工」），**不要**说成「已经安排人做了」。",
    "",
    "### 派活红线（三条路径都适用）",
    "  · **brief 必须是用户要的终态**：绝不许为了迁就名册而缩小用户的诉求。典型错法：用户要「更新这份线上文档」，你降级成「先只读起草一份草稿」派给只读岗，再说「你点头后我再派一次执行写入」——用户要的是终态，不是草稿。先出草稿只在**用户自己要求**时才做。",
    "  · **不许为了凑现有员工的能力把一件活拆成两个任务**。只有任务**本身**有先后依赖（B 必须等 A 的产出）才拆，用 afterTask 排顺序；一开始就知道有 3 步以上 → 回第 1 问派 lead，别手搓长链。",
    "  · **定时活遇到名册里没人对口 → 先建岗再定时化，两步走**：dispatch_task 派 `hr` 建岗（brief 里点明「这是给定时任务用的：会独立触发、没有对话历史、要什么工具与权限」），你批准落盘后再回来 create_schedule 挂给他。临时工在定时任务里用不了——他是任务级的，下次触发时早已释放。",
    "  · 用户报 bug / 提问题，默认诉求是「修好它」，不是只定位。",
    "  · **模糊到写不出验收标准**（对象、范围、什么算做完，三者缺其二）→ dispatch_task 填上 clarify 问清那个关键点，别凭猜派下去。只缺一个次要细节就照常派，别为了严谨反复追问。",
    "**Q3｜剩下的部分你自己就能答吗？** → 直接回话，不调工具",
    "  · 寒暄、关于你/团队/任务状态的元问题。",
    "  · **追问已交付结果的内容** → 答案在已收尾任务里（细节按上面「事实来源」取原文）。",
    "  · **问某任务为什么失败** → 同上，取原文看真实原因（限流、鉴权、无输出等）如实说明。",
    "  · 用户在抱怨/质疑某个结果 → 那是反馈不是新任务，先问清哪里不对，别急着盲目重派。",
    "  · **答案涉及某个具体任务时，务必带上任务号（#id）**——用户才能对上号，也避免你我说的不是同一件事。",
    "",
    "判断顺序上：先看会话历史里**你上一句说了什么**——「看下为什么」这类指代，所指几乎总在前文，任务快照只是补充。",
    "",
    // ── 名册 ──
    "## 团队名册（回答「团队有谁」以此为准，不要编造）",
    rosterBrief(),
    "（另有「hr」负责招募：用户想加人时派给他；规则树第 3 问里「没人能干且必须多步接力」的活也派给他。两种情况他交付的都是**待你批准的建岗提案**，不是把活干完。）",
    liveTempBrief(input.chatId),
    "",
    // ── 确定性快照 ──
    "## 当前任务状态（系统提供的事实，比你的记忆可靠）",
    `进行中：\n${activeBlock}`,
    "",
    `最近收尾（只给摘要，要原文调 get_task_detail）：\n${finishedBlock}`,
    "",
    "**上面只是进行中 + 最近收尾**。跨会话、更早的任务在长期档案里：用 `search_task_history` 按关键词 / 员工 / 日期查，" +
      "用 `get_task_record` 按任务号取完整档案（结论 / 产出物 / 验证 / 关键决策）。" +
      "用户问「之前那件事」而快照里没有 → **先查档案再回答**，查完确实没有才说没有记录。",
    "",
    // ── 记忆 ──
    input.memory ? `## 你对这位用户的记忆\n${input.memory}\n（用它调整语气/称呼/详略，但**绝不主动向用户复述这些内容**，尤其群聊）\n` : "",
    // ── 对话环境 ──
    `## 对话环境\n渠道 ${input.channel}｜${input.chatType === "group" ? "群聊（被 @）" : "私聊"}｜发送人 ${input.senderName ?? "未知"}`,
    input.chatType === "group" ? "群聊里更简短，避免刷屏。" : "",
    "",
    "调了工具就把结果如实告诉用户（带上任务号）；工具返回失败就如实说失败。",
    waiting.length === 0
      ? "（当前没有同事在等回答，所以你这轮不会有 answer_employee_question 工具可用。）"
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 把 boss 的主动播报记进会话。
 *
 * 为什么必须记：用户追问「看下为什么」时，所指往往是 boss 刚播报的那条
 * （员工交付/验收失败）。播报不是模型生成的（模板拼的），不记进去会话里就没有
 * 这个锚点，boss 只能靠任务快照猜——这正是 2026-08-04 连续答错三轮的成因。
 *
 * 只存摘要：员工产出中位 876 字、最大 5065，原文进会话既涨钱又稀释注意力；
 * 全文在 TaskManager 里，模型需要时调 get_task_detail 取。
 */
const BROADCAST_SUMMARY_MAX = 200;

export function appendBossBroadcast(chatId: string, text: string): void {
  const pkey = personaKey();
  const sid = getBossSession(chatId, pkey);
  if (!sid) return; // 还没建立会话（agent 模式未启用或首轮未发生）→ 无需记录
  const session = loadSession(sid);
  if (!session) return;

  const summary = text.replace(/\s+/g, " ").trim().slice(0, BROADCAST_SUMMARY_MAX);
  if (!summary) return;
  const note = `（我向用户播报）${summary}`;

  // 合并进末尾的 assistant 消息而不是新推一条——避免出现连续同角色消息
  const last = session.messages[session.messages.length - 1];
  if (last?.role === "assistant" && typeof last.content === "string") {
    last.content = `${last.content}\n\n${note}`;
  } else {
    session.messages.push({ role: "assistant", content: note });
  }
  session.messages = sanitizeSessionMessages(session.messages);
  session.tokenEstimate = estimateTokens(session.messages);
  session.lastActiveAt = Date.now();
  saveSession(session);
}

export interface BossAgentResult {
  text: string;
  actions: string[];
  isError: boolean;
}

/**
 * 跑一轮 boss agent。
 * 返回给用户的文本 + 本轮实际发生的动作（供调用方记账/播报）。
 */
export async function runBossAgent(
  msg: ChannelMessage,
  candidates: BaseAgent[],
): Promise<BossAgentResult> {
  const p = loadBossPersona();
  const pkey = personaKey(p);
  const resume = getBossSession(msg.chatId, pkey);

  const waiting = tm.waitingTasks(msg.chatId);
  const active = tm.activeTasks(msg.chatId);
  const finished = tm.recentFinishedTasks(msg.chatId, 5);

  const actions: string[] = [];
  const tools = buildBossTools({
    msg,
    candidates,
    waiting,
    onAction: (a) => actions.push(a),
  });

  const systemPrompt = buildSystemPrompt({
    waiting,
    active,
    finished,
    memory: loadBossMemory(msg.chatId, msg.senderId),
    channel: msg.channel,
    chatType: msg.chatType,
    senderName: msg.senderName,
    chatId: msg.chatId,
  });

  /**
   * 脑爆注入：索引常驻，正文按需。
   *
   * - 话题索引（一行一个）始终注入：让 boss 知道「这个话题存在过」，它才可能主动去捞。
   *   不注入索引 = boss 压根不知道该调 read_thinking。
   * - 完整摘要**只注入当前正在谈的那个话题**（当前工作面），其余靠 read_thinking 按需拉。
   *   全量常驻会在聊过十个话题后把注意力挤爆。
   * - 纪律段落只在「模式已激活」或「显式脑爆措辞」时注入，避免稀释主决策树。
   */
  const topicIndex = listTopicIndex(msg.chatId);
  const activeTopic = activeThinkingTopic(msg.chatId);
  const inThinking = Boolean(activeTopic) || looksLikeThinkingRequest(msg.text);
  const currentDigest = activeTopic ? readTopic(msg.chatId, activeTopic) : undefined;

  const fullPrompt = [
    systemPrompt,
    topicIndex.length
      ? `\n## 聊过的话题（要看细节调 read_thinking）\n${renderTopicIndex(topicIndex)}`
      : "",
    inThinking ? `\n${thinkingModeSection(currentDigest)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prov = resolveProvider({ id: config.boss.providerId, model: config.boss.model });
  const model = config.boss.model ?? config.routerModel ?? prov.providerDefaultModel ?? config.model;
  const startedAt = Date.now();

  try {
    const { text, actions: acted, sessionId, emptyOutput } = await runTurn({
      systemPrompt: fullPrompt,
      prompt: msg.text,
      tools,
      model,
      env: prov.env as Record<string, string>,
      resume,
      actions,
    });
    if (sessionId) setBossSession(msg.chatId, sessionId, pkey);

    // 空输出且重试也没救回来：日志如实标错（便于事后统计模型抽风频率），
    // 但不当 isError 返回——用户收到的是友好兜底文案，比技术报错可读
    record(msg, model, startedAt, text || "（空输出，重试后仍无内容）", acted, Boolean(emptyOutput));
    return { text, actions: acted, isError: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[boss-agent] 执行失败:", reason);
    record(msg, model, startedAt, reason, actions, true);
    return { text: reason, actions, isError: true };
  }
}

/**
 * 消费一次 run 的事件流，统一三处调用点（首轮 + 两道守卫的重试）的取数规则。
 *
 * 抽出来的直接原因是它们各写一遍时漏了同一条：**带 emptyOutput 的结果不能把 result
 * 当回复文本**。那是一句内部错误文案（「模型没有产生任何输出…」），一旦当成回复，
 * 用户就会直接看到它；而且 text 一非空，空输出守卫也不会再触发。
 *
 * isError 不在这里抛，以返回值交回调用方——首轮该抛，守卫的重试不该抛（重试失败要退回
 * 友好兜底文案，不能把技术错误糊到用户脸上）。
 */
async function consumeRun(stream: AsyncIterable<RuntimeEvent>): Promise<{
  text: string;
  sessionId?: string;
  emptyOutput: boolean;
  error?: string;
  retryable?: boolean;
  errorSource?: string;
  statusCode?: number;
}> {
  let text = "";
  let sessionId: string | undefined;
  let emptyOutput = false;
  let error: string | undefined;
  let retryable: boolean | undefined;
  let errorSource: string | undefined;
  let statusCode: number | undefined;
  for await (const ev of stream) {
    if (ev.event === "text") text += String(ev.data.text ?? "");
    else if (ev.event === "session") sessionId = String(ev.data.sessionId ?? "") || undefined;
    else if (ev.event === "result") {
      const r = ev.data as {
        result?: string;
        sessionId?: string;
        isError?: boolean;
        emptyOutput?: boolean;
        retryable?: boolean;
        errorSource?: string;
        statusCode?: number;
      };
      if (r.sessionId) sessionId = r.sessionId;
      if (r.emptyOutput) {
        emptyOutput = true;
        continue;
      }
      if (!text.trim() && r.result) text = r.result;
      if (r.isError) {
        error = r.result || "boss agent 执行出错";
        retryable = r.retryable;
        errorSource = r.errorSource;
        statusCode = r.statusCode;
      }
    }
  }
  return {
    text,
    ...(sessionId ? { sessionId } : {}),
    emptyOutput,
    ...(error ? { error } : {}),
    ...(retryable != null ? { retryable } : {}),
    ...(errorSource ? { errorSource } : {}),
    ...(statusCode ? { statusCode } : {}),
  };
}

/**
 * 一轮对话 + 两道守卫。
 * - 空输出守卫：模型一个字都没吐（reasoning 有、text 空，实测会间歇发生）→ 沿原 session 重试一次。
 * - 交付守卫：回复里出现动作断言却没有任何 tool call → 追加一轮要求它补调工具。
 *   这是安全网；主机制是 boss 真有工具、不必撒谎。
 *
 * 导出供 __fixtures__ 直接驱动：守卫这类逻辑最容易出的 bug 是**不可达**
 * （曾经空输出守卫就排在 throw 之后，永远执行不到），必须能被断言。
 */
export async function runTurn(input: {
  systemPrompt: string;
  prompt: string;
  tools: Record<string, unknown>;
  model?: string;
  env?: Record<string, string>;
  resume?: string;
  actions: string[];
}): Promise<{ text: string; actions: string[]; sessionId?: string; emptyOutput?: boolean }> {
  const runtime = getRuntime();
  let text = "";
  let sessionId = input.resume;
  // 模型「一个字都没吐」与「真的执行出错」要分开处理：前者可以沿原 session 重试一次
  // （见 vercel-runtime 的 emptyOutput）。不区分的话下面的空输出守卫就是死代码——
  // isError 会在守卫之前把整轮抛掉，这正是 04:07 那次 8 秒失败漏过去的原因。
  let firstRun: Awaited<ReturnType<typeof consumeRun>> | undefined;
  for (let attempt = 0; attempt <= BOSS_RETRY_DELAYS_MS.length; attempt++) {
    const stream = await runtime.run({
      prompt:
        attempt === 0
          ? input.prompt
          : "【系统自动恢复】上一轮因模型网关或网络临时错误中断。继续处理上一条用户消息；先检查会话中的工具结果，已经成功的动作不要重复执行。",
      systemPrompt: input.systemPrompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      persistSession: true,
      maxSteps: config.boss.maxSteps ?? 8,
      sdkOptions: { tools: input.tools, systemPrompt: input.systemPrompt },
    });
    firstRun = await consumeRun(stream);
    if (firstRun.sessionId) sessionId = firstRun.sessionId;
    if (!firstRun.error) break;
    if (!firstRun.retryable || attempt >= BOSS_RETRY_DELAYS_MS.length) {
      throw new Error(
        `${firstRun.errorSource === "model_gateway" ? "模型网关" : "运行时"}${firstRun.statusCode ? ` HTTP ${firstRun.statusCode}` : ""}：${firstRun.error}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, BOSS_RETRY_DELAYS_MS[attempt]));
  }
  if (!firstRun) throw new Error("boss agent 未产生运行结果");
  text = firstRun.text;
  const emptyOutput = firstRun.emptyOutput;
  if (firstRun.error) throw new Error(firstRun.error);

  // 空输出守卫：这轮一个字都没输出 → 用户只会收到一句「没组织出回复」，等于白丢一轮。
  // 沿原 session 重试一次；放在交付守卫**之前**，好让重试产出的文本仍过一遍谎报检查。
  if (!text.trim() && sessionId) {
    const acted = input.actions.length > 0;
    console.warn(`[boss-agent] 本轮无文本输出（已调工具=${acted}），触发空输出守卫重试`);
    const retry = await runtime.run({
      prompt: acted
        ? "【系统提醒】你刚才调了工具，但**没有输出任何文字**——用户看不到任何回应，会以为没反应。用一两句话把你做了什么、结果如何告诉他（带上任务号）。不要重复调工具。"
        : "【系统提醒】你刚才**没有输出任何文字**，用户看到的是一片空白。现在直接回他一句：能答就答；信息不够就说清缺什么、或者说你这边没有相关记录。不要沉默。",
      systemPrompt: input.systemPrompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.env ? { env: input.env } : {}),
      resume: sessionId,
      persistSession: true,
      maxSteps: config.boss.maxSteps ?? 8,
      sdkOptions: { tools: input.tools, systemPrompt: input.systemPrompt },
    });
    const retried = await consumeRun(retry);
    if (retried.sessionId) sessionId = retried.sessionId;
    if (retried.text.trim()) text = retried.text;
  }

  // 交付守卫
  const claimed = claimsAction(text);
  if (claimed && input.actions.length === 0 && sessionId) {
    console.warn("[boss-agent] 检测到动作断言但无 tool call，触发守卫补调");
    const retry = await runtime.run({
      prompt: [
        "【系统提醒】你刚才的回复里说了「已安排/已取消/已转达」这类话，但你**没有调用任何工具**——也就是说那件事实际上没有发生，用户会被误导。",
        "现在请二选一：",
        "1. 如果确实该做那个动作 → 立刻调用对应工具真正执行，然后简短确认。",
        "2. 如果其实不需要做动作（只是在陈述或询问） → 重新组织一遍回复，去掉会让用户以为你已经执行了的措辞。",
      ].join("\n"),
      systemPrompt: input.systemPrompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.env ? { env: input.env } : {}),
      resume: sessionId,
      persistSession: true,
      maxSteps: config.boss.maxSteps ?? 8,
      sdkOptions: { tools: input.tools, systemPrompt: input.systemPrompt },
    });
    const retried = await consumeRun(retry);
    if (retried.sessionId) sessionId = retried.sessionId;
    if (retried.text.trim()) text = retried.text;
  }

  return {
    text: text.trim(),
    actions: input.actions,
    ...(sessionId ? { sessionId } : {}),
    // 只有「空输出发生过 + 重试也没救回来」才置位：用户侧走友好兜底文案，
    // 但决策日志要如实标错，否则这类故障会伪装成一次正常的直答，事后查不出来
    ...(emptyOutput && !text.trim() ? { emptyOutput: true } : {}),
  };
}

const BOSS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

function record(
  msg: ChannelMessage,
  model: string | undefined,
  startedAt: number,
  output: string,
  actions: string[],
  isError: boolean,
): void {
  const entry = appendBossDecision({
    time: new Date(startedAt).toISOString(),
    kind: "intent",
    summary: `agent 处理：${msg.text.replace(/\s+/g, " ").slice(0, 60)}${actions.length ? ` → ${actions.join(", ")}` : " → 直答"}`,
    chatId: msg.chatId,
    model: model ?? "(默认)",
    durationMs: Date.now() - startedAt,
    ...(isError ? { isError: true } : {}),
    prompt: msg.text,
    output,
  });
  publishBossDecision(entry);
}

// ─── 统一事件驱动入口 ────────────────────────────────────────

/**
 * 统一入口：接受 InboxEvent（用户消息或系统事件），驱动一次完整 boss 推理循环。
 *
 * 对用户消息：等价于 runBossAgent（向后兼容）。
 * 对系统事件：构造合成 ChannelMessage + 增强 system prompt（situation + trigger framing），
 * 复用同一个 runTurn。系统事件轮不向 session 追加 user message（防膨胀），
 * 但 boss 产出仍记入 broadcast log。
 */
export async function runBossForEvent(
  event: InboxEvent,
  candidates: BaseAgent[],
): Promise<BossAgentResult> {
  // 用户消息：直接走原路径
  if (event.kind === "user_message") {
    const { msg } = event.payload as UserMessagePayload;
    return runBossAgent(msg, candidates);
  }

  // 系统事件：构造合成上下文。
  // system_error 没有绑定任务（是进程级的基础设施错误），投递落点用系统级通知目标。
  let syntheticMsg: ChannelMessage;
  if (event.kind === "system_error") {
    const target = notifyTarget();
    syntheticMsg = {
      channel: target.channel,
      chatType: target.chatType,
      chatId: target.chatId,
      senderId: target.ownerSenderId,
      senderName: "系统",
      text: frameTrigger(event),
      raw: null,
    };
  } else {
    const payload = event.payload as SystemEventPayload;
    const task = payload.task;
    syntheticMsg = {
      channel: task.channel,
      chatType: task.chatType as "private" | "group",
      chatId: task.chatId,
      senderId: task.ownerSenderId,
      senderName: task.ownerSenderName,
      text: frameTrigger(event),
      raw: null,
    };
  }

  const p = loadBossPersona();
  const pkey = personaKey(p);
  const resume = getBossSession(syntheticMsg.chatId, pkey);

  const waiting = tm.waitingTasks(syntheticMsg.chatId);

  const actions: string[] = [];
  const tools = buildBossTools({
    msg: syntheticMsg,
    candidates,
    waiting,
    onAction: (a) => {
      actions.push(a);
      markBossAction(syntheticMsg.chatId, a);
    },
  });

  // 系统事件用增强的 prompt：situation 替换散装快照 + 事件前言 + 触发帧
  const situation = buildSituation(syntheticMsg.chatId);
  const active = tm.activeTasks(syntheticMsg.chatId);
  const finished = tm.recentFinishedTasks(syntheticMsg.chatId, 5);

  const basePrompt = buildSystemPrompt({
    waiting,
    active,
    finished,
    memory: loadBossMemory(syntheticMsg.chatId, syntheticMsg.senderId),
    channel: syntheticMsg.channel,
    chatType: syntheticMsg.chatType,
    senderName: syntheticMsg.senderName,
    chatId: syntheticMsg.chatId,
  });

  // 在 system prompt 末尾追加：态势快照增强 + 系统事件 preamble
  const systemPrompt = [
    basePrompt,
    "",
    "## 态势总览",
    renderSituation(situation),
    "",
    systemEventPreamble(event),
  ].join("\n");

  const prov = resolveProvider({ id: config.boss.providerId, model: config.boss.model });
  const model = config.boss.model ?? config.routerModel ?? prov.providerDefaultModel ?? config.model;
  const startedAt = Date.now();

  try {
    const { text, actions: acted, sessionId, emptyOutput } = await runTurn({
      systemPrompt,
      prompt: syntheticMsg.text,
      tools,
      model,
      env: prov.env as Record<string, string>,
      resume,
      actions,
    });
    if (sessionId) setBossSession(syntheticMsg.chatId, sessionId, pkey);

    // 系统事件轮的产出记入 broadcast log（用户追问时 boss 有锚点）
    if (text.trim()) appendBossBroadcast(syntheticMsg.chatId, text);

    // 记录 token 消费到 budget
    recordSystemTurn(syntheticMsg.chatId, estimateTokens([{ role: "assistant", content: text }]));

    recordEvent(event, model, startedAt, text || "(系统事件轮无输出)", acted, Boolean(emptyOutput));
    return { text, actions: acted, isError: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[boss-agent] 系统事件轮执行失败:", reason);
    recordEvent(event, model, startedAt, reason, actions, true);
    return { text: reason, actions, isError: true };
  } finally {
    clearBossActions(syntheticMsg.chatId);
  }
}

function recordEvent(
  event: InboxEvent,
  model: string | undefined,
  startedAt: number,
  output: string,
  actions: string[],
  isError: boolean,
): void {
  const summary = `系统事件(${event.kind})${actions.length ? ` → ${actions.join(", ")}` : " → 无动作"}`;
  const entry = appendBossDecision({
    time: new Date(startedAt).toISOString(),
    kind: "intent",
    summary,
    chatId: event.chatId,
    model: model ?? "(默认)",
    durationMs: Date.now() - startedAt,
    ...(isError ? { isError: true } : {}),
    prompt: `[event:${event.kind}]`,
    output,
  });
  publishBossDecision(entry);
}
