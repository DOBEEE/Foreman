import { loadBossPersona } from "./persona.js";
import { loadReportStyle } from "./report-style.js";
import { bossThink } from "./think.js";

/** boss 对员工一轮产出的验收结论 */
export interface ReviewVerdict {
  /** completed=验收通过 / needs_user=其实在等用户输入 / failed=明确失败 */
  status: "completed" | "needs_user" | "failed";
  /** needs_user 时：从产出中提取的、面向用户的问题（含选项） */
  question?: string;
  /**
   * completed/failed 时：真正发给用户的那段文字。
   *
   * 早先交卷路径把它算出来又丢掉，改发 `renderTaskReport` 的机械五段式——于是用户在一个
   * 修 bug 任务里读到的是「为什么拆两步」「我 Bash 了 git diff」这类内部编排，
   * 而根因和改动被埋在中间。现在结构与长度由模型按 `report-style.md`（用户可编辑）自己判断。
   */
  summary?: string;
}

/**
 * boss 验收：判员工这一轮到底算不算干完。
 *
 * 两条入口，纪律不同：
 * - **非交卷路径**（员工既没提问也没交卷）：原始场景，裁决 completed/needs_user/failed，
 *   异常一律 fail-closed 判 failed。
 * - **交卷路径**（`submitted`，员工显式调了 report_task_done）：裁决空间收窄为
 *   completed/failed，且异常回落 completed。理由见 `submitted` 参数说明。
 *
 * 顺带产出 leader 式汇报摘要（与裁决同一次调用，零额外成本）。
 */
export async function reviewEmployeeOutput(
  employeeDisplay: string,
  taskPrompt: string,
  output: string,
  /** 决策日志归属：让这次验收挂到任务时间线上 */
  ref: { chatId?: string; taskId?: string; agentName?: string } = {},
  opts: {
    /**
     * 员工显式交卷（report_task_done）。
     *
     * 两条差异都是必需的护栏：
     * 1. **禁止 needs_user**——他已经显式交卷了，要提问该走 ask_user 工具。放开这条会让
     *    验收环节凭空升级、去打扰用户。
     * 2. **异常回落 completed**（而非 fail-closed）。全量接入后每个任务都要过这一关，
     *    一次网关 429 就会把已交付的活播报成「未通过验收」再烧两轮追问；更糟的是
     *    retro/optimizer 也走交卷路径，误判会让 schedule 的 failCount 累加到阈值后
     *    **自动停用定时任务**——验收抖动被放大成「定时任务静默消失」。
     *    交卷时手上有一份结构化报告作证据，回落通过是可辩护的那一侧。
     */
    submitted?: boolean;
    /** 派工时定下的验收标准：作为独立段落要求逐条核对（写在 prompt 自由文本里没人当依据） */
    acceptance?: string;
    /** 产出合约硬校验查出的缺失项：非空则直接判 failed，不问模型 */
    contractMissing?: string[];
  } = {},
): Promise<ReviewVerdict> {
  const p = loadBossPersona();
  const { submitted, acceptance, contractMissing } = opts;

  // 硬校验已经给出确定性结论：文件在不在是 fs 一次调用能定论的事，不必也不该问模型
  if (contractMissing?.length) {
    return {
      status: "failed",
      summary: [
        "结论：没干完——声明要产出的东西没找到（已用文件系统实际核查，不是判断）。",
        `交付物：缺 ${contractMissing.join("；")}`,
        "风险与遗留：产出缺失，不要当成品使用。",
      ].join("\n"),
    };
  }

  try {
    const prompt = [
      `你是「${p.name}」，${p.role}。员工「${employeeDisplay}」刚交回一轮产出，请你验收并出一份向上汇报。`,
      // summary/question 会原样发给用户：与直答保持同一人格口吻（但汇报以信息密度优先，克制使用语气词）
      `你的表达风格：${p.style}`,
      `## 任务原始诉求\n${taskPrompt.slice(0, 800)}`,
      acceptance ? `## 验收标准（派工时定下的，请逐条核对）\n${acceptance.slice(0, 600)}` : "",
      `## 员工产出（原文）\n${output.slice(0, 6000)}`,
      "## 验收判定（status）",
      submitted
        ? [
            "员工已经**显式交卷**（调了交卷工具，产出是结构化报告）。只判两种：",
            "- completed：报告里能指认出至少一件**已完成**的具体交付物（文件/分支/CR 地址/结论数据）。",
            "- failed：报告通篇是计划或未来时，拿不出任何已完成的交付物；或它自陈有步骤未执行/失败/待补齐。",
            "**不要**判 needs_user：他要问用户会用提问工具，这里不是提问的地方。",
            "注意：「已重新编队」「下一步会…」这类措辞若**同时**给出了已完成的交付物，算 completed，不要因为出现未来时就判失败。",
          ].join("\n")
        : [
            "- needs_user：产出**实质上在等用户回答**才能继续——包含明确抛给用户的问题/选择（如「需你确认」「请告诉我」「是否要我…?」），且不回答就无法收尾。",
            "- completed：工作已收尾。允许带「风险与遗留」，那不算 needs_user；修饰性的「如还有问题可以找我」也不算。",
            "- failed：员工明确表示无法完成/卡死。",
            "**判 completed 前必须先排除「只有计划、没有产出」**：",
            "- 产出通篇是未来时/进行时——「方案已提交」「N 步执行中」「已重新编队」「新计划如下」「执行完毕后我会…」「稍后交卷」——而拿不出**已经做完**的交付物，判 failed，不是 completed。",
            "- 列出待办步骤 ≠ 完成这些步骤。只要正文自陈有步骤「未执行 / 失败 / 待补齐」，就判 failed。",
            "- 判 completed 的最低要求：能从产出里指认出至少一件**已完成**的具体交付物（文件/分支/CR 地址/结论数据）。",
          ].join("\n"),
      "## 输出要求（只输出 JSON，不要其他内容）",
      submitted
        ? '{"status":"completed|failed","summary":"..."}'
        : '{"status":"completed|needs_user|failed","question":"...","summary":"..."}',
      submitted
        ? ""
        : "- needs_user：question = 把员工的问题整理成面向用户的清晰提问（保留所有选项与关键上下文，可用 1. 2. 编号；**问题原文中的路径/命令/代码一字不改**）。不需要 summary。",
      "- completed/failed：summary = 你转达给用户的那段文字。**结构和长度由你自己判断**，",
      "  唯一硬约束是下面这份汇报风格手册（用户自己写的，他要看什么以此为准）：",
      `\n${loadReportStyle()}\n`,
      "  另外两条不可破：只提炼员工产出中**明确存在**的信息，路径/行号/commit/数字一字不改；",
      "  不评价不脑补。不需要 question。",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { text: out, isError } = await bossThink({
      kind: "review",
      summary: `验收「${employeeDisplay}」这一轮产出`,
      prompt,
      ...(ref.chatId ? { chatId: ref.chatId } : {}),
      ...(ref.taskId ? { taskId: ref.taskId } : {}),
      ...(ref.agentName ? { agentName: ref.agentName } : {}),
    });
    if (isError) throw new Error(out || "review 调用失败");
    const json = out.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("review 输出非 JSON");
    const parsed = JSON.parse(json) as ReviewVerdict;
    if (!["completed", "needs_user", "failed"].includes(parsed.status)) {
      throw new Error(`review status 非法: ${parsed.status}`);
    }
    // 交卷路径不接受 needs_user：模型偶尔仍会给出，按通过处理（他手上有结构化报告）
    if (submitted && parsed.status === "needs_user") {
      return { status: "completed", summary: parsed.summary ?? parsed.question };
    }
    if (parsed.status === "needs_user" && !parsed.question?.trim()) {
      throw new Error("needs_user 但缺 question");
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[boss] 验收裁决失败:", reason);
    // 非对称 fail-closed（见 opts.submitted）：交卷路径有结构化报告作证据，
    // 验收环节自己挂了不该把已交付的活打成失败——那会连带把定时任务刷到自动停用。
    if (submitted) {
      return { status: "completed" };
    }
    // 非交卷路径：验收环节自己挂了不代表员工干完了。判 failed 会走 boss 的追问流程
    // （有预算上限），比把没做完的活当成品交付给用户安全得多。
    return {
      status: "failed",
      summary: [
        "结论：没能完成验收——验收环节本身出错了，这一轮产出未经确认。",
        `交付物：员工原始输出见任务记录（${output.length} 字）`,
        `风险与遗留：验收失败原因「${reason.slice(0, 200)}」；产出未经核验，不要直接当成结论使用。`,
      ].join("\n"),
    };
  }
}

/**
 * 构造验收上下文（供 emitSystemEvent 和 trigger-frame 使用）。
 * 保留硬校验逻辑在此：如果 contractMissing 非空，直接判 failed 不进 LLM。
 */
export function buildReviewContext(task: {
  id: string;
  agentName: string;
  prompt: string;
  acceptance?: string;
}, output: string, contractMissing: string[]): Record<string, unknown> {
  return {
    output,
    agentDisplay: task.agentName,
    acceptance: task.acceptance ?? "",
    contractMissing: contractMissing.length > 0 ? contractMissing : undefined,
  };
}
