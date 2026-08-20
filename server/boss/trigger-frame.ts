import type {
  InboxEvent,
  UserMessagePayload,
  SystemEventPayload,
  InfraEventPayload,
} from "./inbox.js";

/**
 * 事件帧构造器：为每种事件类型生成注入 boss 循环的 "伪用户消息"。
 *
 * 用户消息原样返回（兼容）。
 * 系统事件格式化为结构化文本 + 可用动作提示，framing 明确告诉 boss：
 * "这不是用户在跟你说话，是系统把你叫醒了，你决定要不要行动"。
 */

export function frameTrigger(event: InboxEvent): string {
  if (event.kind === "user_message") {
    return (event.payload as UserMessagePayload).msg.text;
  }
  // system_error 用的是 InfraEventPayload（无 task），必须在转 SystemEventPayload 之前处理
  if (event.kind === "system_error") {
    return frameSystemError(event.payload as InfraEventPayload);
  }
  const p = event.payload as SystemEventPayload;
  switch (event.kind) {
    case "task_completed":
      return frameTaskCompleted(p);
    case "task_failed":
      return frameTaskFailed(p);
    case "handoff_needed":
      return frameHandoffNeeded(p);
    case "employee_question":
      return frameEmployeeQuestion(p);
    case "schedule_alert":
      return frameScheduleAlert(p);
    case "capability_gap":
      return frameCapabilityGap(p);
    default:
      return `【系统事件】${event.kind}`;
  }
}

/**
 * 系统事件轮的 system prompt 追加段落。
 *
 * 两个职责：
 * 1. 告诉 boss 本轮的触发方式（不是用户在跟你说话）
 * 2. 完整声明"在系统事件轮里你能做什么" — 必须与 boss-tools 里实际注册的工具一一对应，
 *    不能多（模型幻觉调不存在的工具）也不能少（模型不知道自己能干这事就不会干）。
 */
export function systemEventPreamble(event: InboxEvent): string {
  if (event.kind === "user_message") return "";
  return [
    "## 本轮触发方式",
    "你不是被用户消息唤醒的——这是一个**系统事件**通知。你的职责是审视事件、做出判断、执行动作。",
    "如果判定无需行动（事件是预期内的正常流转），回复「无需行动」即可，不要强行做事。",
    "",
    "## 你在系统事件轮中的完整能力清单",
    "以下是你**当前拥有的全部工具**。每个工具的适用时机在括号里说明——不确定用哪个时看这里。",
    "",
    "### 通知与沟通",
    "- **notify_user** — 主动向用户推送消息（失败告知、完成播报、需确认的问题、进度更新）。你组织语言，说人话。",
    "",
    "### 验收与完结",
    "- **complete_task** — 验收通过，标记任务完成（员工产出满足验收标准时用）",
    "- **fail_task** — 判定任务失败并通知用户（不可恢复的错误、反复返工仍未达标时用）",
    "",
    "### 继续执行",
    "- **retry_task** — 原地重试失败任务（瞬态错误：限流/网络/网关临时不可用时用）",
    "- **send_feedback** — 向员工追问或发返工指示（验收未通过但不判死，告诉他哪里不对时用）",
    "- **continue_task** — 续派/补充信息给员工（代答员工提问、或接着未完成的活时用）",
    "",
    "### 调度与换人",
    "- **reassign_task** — 取消原任务并重派给另一位员工（当前执行人不适合/反复失败时用）",
    "- **dispatch_task** — 派新任务给指定员工（交接后继需要启动时用）",
    "- **cancel_task** — 取消任务（交接判定后继不再需要时用）",
    "",
    "### 招募（当名册里没人能干时）",
    "- **hire_temp_worker** — 现招一个临时工（单步能交的活，名册里无人覆盖时用）。权限按需给：纯查阅不填 tools，要改文件就加 Write/Edit/Bash + readRoots。",
    "- **dispatch_task 派给 hr** — 让 hr 设计一个新岗位（多步接力、且现有员工覆盖不了时用）。hr 交付的是建岗提案，需用户批准后才有人开工。",
    "",
    "### 定时任务",
    "- **resume_schedule** — 恢复被停用的定时任务",
    "- **cancel_schedule** — 取消定时任务",
    "",
    "### 查询（辅助判断用，不影响状态）",
    "- **get_task_detail** — 查任务全文（产出/报错原文）",
    "- **list_tasks** — 看当前会话所有任务",
    "- **search_task_history** — 搜长期档案",
    "",
    "## 决策原则",
    "- **先判断再行动**：看清事件全貌后再决定，不要见到错误就无脑重试。",
    "- **该放手就放手**：凭据错误/配置错误/模型不存在这类，重试一万次也一样——判 fail_task + notify_user 告知用户。",
    "- **该升级就升级**：当前执行人反复失败、或声明不会 → reassign_task 换人，或 hire_temp_worker 招临时工。",
    "- **不要隐瞒**：坏消息用 notify_user 直接告知用户，不粉饰、不拖延。",
    "- **不要替代用户做重大决策**：凭据/授权/方向性变更 → notify_user 交给用户定。",
  ].join("\n");
}

// ─── Formatters ───────────────────────────────────────────────

function frameTaskCompleted(p: SystemEventPayload): string {
  const { task, context } = p;
  const output = String(context.output ?? "").slice(0, 3000);
  const acceptance = context.acceptance ? String(context.acceptance) : "";
  const contractMissing = context.contractMissing as string[] | undefined;

  const lines = [
    "【系统事件：员工交付】",
    `任务 #${task.id}（执行人：${context.agentDisplay ?? task.agentName}）刚交回产出。`,
    `诉求：${(task.brief ?? task.prompt).slice(0, 200)}`,
    "",
    `产出：\n${output}`,
  ];
  if (acceptance) {
    lines.push("", `验收标准：${acceptance}`);
  }
  if (contractMissing?.length) {
    lines.push("", `⚠️ 硬校验发现缺失（文件系统已确认不存在）：${contractMissing.join("、")}`);
    lines.push("硬校验缺失 = 判 fail_task 或 send_feedback 让员工补齐，不要判 complete_task。");
  }
  lines.push(
    "",
    "请验收并决定下一步（参照上方能力清单选工具）。",
  );
  return lines.join("\n");
}

function frameTaskFailed(p: SystemEventPayload): string {
  const { task, context } = p;
  const errorText = String(context.errorText ?? "").slice(0, 1500);
  const retries = Number(context.retries ?? 0);
  const remaining = Number(context.remaining ?? 0);
  const source = context.errorSource ? `来源：${context.errorSource}` : "";

  const lines = [
    "【系统事件：任务执行出错】",
    `任务 #${task.id}（执行人：${context.agentDisplay ?? task.agentName}）报错了。`,
    source,
    `错误：${errorText}`,
    `已重试 ${retries} 次，剩余自动重试预算 ${remaining} 次。`,
    "",
    "判断依据：",
    "- 「稍后重试 / rate limit / 429 / 503 / timeout / temporarily」→ 瞬态，值得 retry_task",
    "- 「invalid credentials / 401 / model not found / 余额不足 / permission denied」→ 不可恢复，fail_task + notify_user",
    "- 反复重试仍失败（retries ≥ 2）→ 考虑 reassign_task 换人，或 hire_temp_worker 招新人试",
    "- 需要用户提供凭据/改配置 → notify_user 说明情况",
    "",
    "请据此决定下一步（参照上方能力清单选工具）。",
  ];
  return lines.filter(Boolean).join("\n");
}

function frameHandoffNeeded(p: SystemEventPayload): string {
  const { task, context } = p;
  const predecessorOutput = String(context.predecessorOutput ?? "").slice(0, 1500);
  const successors = context.successors as Array<{ id: string; brief: string }> | undefined;

  const lines = [
    "【系统事件：任务交接待决】",
    `前驱任务 #${task.id}（${context.predecessorState ?? task.state}）已结束。`,
    `前驱产出：${predecessorOutput}`,
    "",
    "后继任务：",
  ];
  if (successors?.length) {
    for (const s of successors) {
      lines.push(`- #${s.id}：${s.brief.slice(0, 80)}`);
    }
  }
  lines.push(
    "",
    "请决定每个后继的走向：",
    "- 前驱成功且后继 brief 仍然合理 → dispatch_task 启动后继",
    "- 前驱产出改变了后继的前提 → dispatch_task 填修正后的 brief",
    "- 前驱已经把后继的活也干完了 → cancel_task 取消后继",
    "- 前驱失败导致后继无法进行 → notify_user 告知用户，等用户决定",
    "- 后继需要的能力名册里没有 → hire_temp_worker 或派 hr 建岗",
  );
  return lines.join("\n");
}

function frameEmployeeQuestion(p: SystemEventPayload): string {
  const { task, context } = p;
  const question = String(context.question ?? "");

  return [
    "【系统事件：员工提问】",
    `任务 #${task.id}（${context.agentDisplay ?? task.agentName}）向用户提问：`,
    question,
    "",
    "判断：",
    "- 答案在已有上下文/任务历史里（用户之前说过）→ continue_task 把答案给员工，省得打扰用户",
    "- 必须用户才能回答（选择/授权/补充只有他知道的信息）→ notify_user 转述问题",
    "- 问题本身不合理（员工在兜圈子/偏题了）→ send_feedback 纠正方向",
  ].join("\n");
}

function frameScheduleAlert(p: SystemEventPayload): string {
  const { context } = p;
  return [
    "【系统事件：定时任务异常】",
    `调度 ${context.scheduleId ?? "未知"}（${context.scheduleName ?? ""}）异常。`,
    `原因：${context.reason ?? "未知"}`,
    `连续失败次数：${context.failCount ?? "?"}`,
    "",
    "判断：",
    "- 瞬态故障（网络/限流）且次数不多 → resume_schedule 恢复",
    "- 执行人不存在/能力缺失 → 先 hire_temp_worker 或派 hr 建岗，再 resume_schedule",
    "- 根本原因需用户处理（凭据/配置）→ notify_user 告知",
    "- 该定时任务已不再需要 → cancel_schedule",
  ].join("\n");
}

function frameCapabilityGap(p: SystemEventPayload): string {
  const { task, context } = p;
  return [
    "【系统事件：员工声明无法完成】",
    `任务 #${task.id}（${context.agentDisplay ?? task.agentName}）声明自己无法完成此任务。`,
    `原因：${context.reason ?? "未说明"}`,
    "",
    "判断：",
    "- 名册里有更合适的人 → reassign_task 换人",
    "- 名册里没人会，但这是单步活 → hire_temp_worker 现招临时工（权限按需给）",
    "- 名册里没人会，且需要多步接力 → dispatch_task 派 hr 设计新岗位",
    "- 任务本身不合理/范围太大需拆解 → dispatch_task 拆成多步，或 notify_user 问用户",
    "- 缺权限/凭据才导致无法完成 → notify_user 告知用户补充",
  ].join("\n");
}

function frameSystemError(p: InfraEventPayload): string {
  const sourceLabel =
    p.source === "unhandled_rejection" ? "未捕获的 promise rejection" : "未捕获异常";

  return [
    "【系统事件：基础设施错误】",
    `类型：${sourceLabel}`,
    p.occurrences > 1 ? `窗口内累计出现 ${p.occurrences} 次（同类错误已去重，只惊动你这一次）` : "",
    "",
    "错误内容：",
    p.errorText,
    "",
    "**进程已被全局兜底救活，服务仍在运行**——但这次错误可能已经让某个任务中断，",
    "而用户对此毫不知情（他只会觉得「怎么没反应」）。",
    "",
    "请判断：",
    "- **先看影响面**：用 list_tasks 看有没有任务卡在 running 却实际已经死了。",
    "- 有任务受影响 → retry_task 重试它，或 fail_task 标记失败并 notify_user 说清原因。",
    "- 错误来自某个外部 MCP server（如抓取超时）且只影响单次调用 → 通常无需行动，回复「无需行动」。",
    "- 反复出现的同类错误（occurrences 较大）→ notify_user 提醒用户这个依赖不稳定，建议检查配置。",
    "- 看不出影响任何任务、也不像会复发 → 回复「无需行动」，不要为了做事而做事。",
    "",
    "注意：**不要**为这条错误新建任务去「调查问题」——那会把一次瞬时故障放大成一堆活。",
  ]
    .filter(Boolean)
    .join("\n");
}

