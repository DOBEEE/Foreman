import { tool } from "ai";
import { z } from "zod";
import type { StepReport } from "../../tools/step-report.js";

/**
 * Vercel AI SDK 版的自定义协议工具。
 * 与 server/tools/ 下现有的 createSdkMcpServer 版并存——
 * ClaudeRuntime 继续用 MCP 版，VercelRuntime 用这些 inline tool 版。
 * 语义完全对齐，只是 API 形式不同。
 */

// ─── ask_user ────────────────────────────────────────────

const askUserParams = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string().optional(),
      options: z.array(z.object({
        label: z.string(),
        description: z.string().optional(),
      })).min(2).max(5),
      multiSelect: z.boolean().optional(),
    }),
  ).min(1),
});

export type AskUserHandler = (questions: z.infer<typeof askUserParams>["questions"]) => void;

export function buildAskUserTool(onAsk: AskUserHandler) {
  return tool({
    description:
      "向用户提问。当你需要用户确认或选择时调用此工具。" +
      "问题会转交给主管，由主管决定是代答还是转发给用户。",
    inputSchema: askUserParams,
    execute: async (input) => {
      onAsk(input.questions);
      return "问题已送达主管，等待回复。在收到回复前请勿继续执行。";
    },
  });
}

// ─── report_task_done ────────────────────────────────────

const reportDoneParams = z.object({
  outcome: z.enum(["done", "cannot_complete"]),
  conclusion: z
    .string()
    .describe("用户可见的核心结论：完整、结论先行且简练，不要把必要信息留到工具调用后的文本中"),
  deliverables: z.string().optional().describe("关键产出物清单；避免与 conclusion 重复"),
  verification: z.string().optional().describe("实际验证及结果；简练，不得声称未执行的验证"),
  risks: z.string().optional().describe("真实风险或遗留；没有则填无"),
  /**
   * 刻意**必填**。这是执行日志和消息历史里都推不出来的那部分——日志只留下一串调用，
   * 看不出"为什么选了 A 不选 B"、"哪条路试过不通"。而员工的下一件活是全新会话，
   * 这些判断没落到结构化字段里就彻底没了。
   *
   * 随手笔记要求记同样的东西，但那是**自愿的**（协议明确允许「今天无可记」），
   * 没有任何机器约束；交卷 schema 是硬门槛，不填交不了卷。所以最有复用价值的这一列
   * 放这里兜底，笔记继续承担「过程中趁热记细节」，两者不冲突。
   */
  decisions: z
    .string()
    .describe(
      "关键决策与理由：在几种做法里选了哪个、为什么，以及试过但放弃的方案和原因。" +
        "只写执行日志里推不出来的判断，不要复述做过哪些操作。确实没有值得留的判断时填「无」",
    ),
});

export type ReportDoneHandler = (report: z.infer<typeof reportDoneParams>) => void;

export function buildReportDoneTool(onReport: ReportDoneHandler) {
  return tool({
    description:
      "任务完成后交卷。无论成功（done）还是无法完成（cannot_complete），" +
      "都必须调用此工具向主管汇报。工具参数是唯一会转达给用户的最终回复：" +
      "信息必须完整、结论先行且简练；调用后不要再输出任何文本。 " +
      "**只在真收尾时调**：任务分阶段（brief 写着「先 X，用户确认后再 Y」）、第一阶段做完要等用户点头才能继续时，" +
      "改用提问工具把成果贴出来等回话——交卷会终结这条会话，后续阶段会变成新任务、可能换个人从零把你查过的重查一遍。",
    inputSchema: reportDoneParams,
    execute: async (input) => {
      onReport(input);
      return "已交卷。本轮已经结束，不要再输出总结或任何其他文本。";
    },
  });
}

// ─── submit_step（编队内向组长交卷） ──────────────────────

/** 交卷入参的固定字段（与 report_task_done 同构，少了对用户的那部分语义） */
const submitStepBase = {
  outcome: z.enum(["done", "cannot_complete"]),
  conclusion: z
    .string()
    .describe("组长可见的核心结论：完整、结论先行且简练，不要复述过程"),
  deliverables: z.string().optional().describe("关键产出物清单（文件/路径/分支/commit/命令）"),
  verification: z.string().optional().describe("实际做过的验证及结果；不得声称未执行的验证"),
  risks: z.string().optional().describe("真实风险或遗留，没有则填「无」"),
  decisions: z
    .string()
    .describe(
      "关键决策与理由：几种做法里选了哪个、为什么，以及试过但放弃的方案。" +
        "只写执行日志里推不出来的判断，没有值得留的填「无」",
    ),
};

export type SubmitStepHandler = (report: StepReport) => string | Promise<string>;

/**
 * `submit_step`：编队成员向**组长**交卷。
 *
 * 为什么必须是工具而不是「把结论写在返回文本里」：编队步骤的产出原先取整段流式文本，
 * 结果组长收尾时读到的是「Now let me do targeted scans per package…」这种旁白，
 * 关键结论在 2000 字截断处被切掉；`produces.data` 声明的字段也只能拿这坨文本
 * 喂轻量 LLM 反向刮取，刮失手就整步重跑。员工对老板早就是「必须调工具表态」，
 * 编队内部只是一直缺这一半。
 *
 * schema 按调用现场动态生成（同一个工具、同一份 builder，不为角色另开一个工具）：
 * - `dataFields`：`produces.data` 声明的字段并入嵌套 `data`，全部必填 → 字段由员工**填**，
 *   不再由引擎猜；
 * - `reviewer`：评审角色多一个必填 `verdict`，让引擎能确定性地驱动「不过就重做」，
 *   而不是再拿评审报告去问一次 LLM（那条路的失败模式是静默按通过放行）。
 */
export function buildSubmitStepTool(
  handler: SubmitStepHandler,
  opts?: { dataFields?: Record<string, string>; reviewer?: boolean },
) {
  const dataFields = opts?.dataFields ?? {};
  const dataKeys = Object.keys(dataFields);
  const shape: Record<string, z.ZodTypeAny> = { ...submitStepBase };
  if (opts?.reviewer) {
    shape.verdict = z
      .enum(["pass", "reject"])
      .describe("评审结论：pass=通过；reject=不通过（feedback 写在 conclusion 里，要具体可执行）");
  }
  if (dataKeys.length > 0) {
    shape.data = z
      .object(
        Object.fromEntries(
          Object.entries(dataFields).map(([k, desc]) => [k, z.string().describe(desc)]),
        ),
      )
      .describe("本步产出合约声明的关键信息，每一项都必须给出真实值");
  }
  return tool({
    description: opts?.reviewer
      ? "评审完成后向组长提交结论。**必须调用**，只输出文本不算提交，会被系统拦回来重做。" +
        "verdict 是引擎判定的唯一依据：pass 则本步通过，reject 会让执行者带着你的意见重做。"
      : "本步做完后向组长交卷。**必须调用**，只输出文本不算交卷，会被系统拦回来重做。" +
        "工具参数是组长和下游步骤唯一能看到的产出，必须一次写完整；调用后不要再输出任何文本。" +
        "这不是对老板交卷，不会结束整个任务——只是把本步成果交给组长。",
    inputSchema: z.object(shape),
    execute: async (input) => {
      // shape 是本函数按现场拼的，推导类型退化成 Record<string, unknown>；
      // 它与 StepReport 的对应关系由上面的 submitStepBase / verdict / data 三段保证。
      return await handler(input as unknown as StepReport);
    },
  });
}

// ─── schedule_later ──────────────────────────────────────

const scheduleLaterParams = z.object({
  delayMinutes: z.number().int().min(1).max(1440)
    .describe("延后多少分钟执行（最多 24 小时）"),
  title: z.string().describe("任务标题"),
  prompt: z.string().describe("到时候给员工的完整任务指令"),
  assignTo: z.string().optional().describe("指定执行的员工 id（留空=自己）"),
});

export type ScheduleLaterHandler = (schedule: z.infer<typeof scheduleLaterParams>) => Promise<string>;

export function buildScheduleLaterTool(onSchedule: ScheduleLaterHandler) {
  return tool({
    description:
      "延后办：把一件事安排到将来某时刻再执行（一次性，最多 24 小时）。" +
      "适合需要等构建完成、等发布后再复查的场景。",
    inputSchema: scheduleLaterParams,
    execute: async (input) => {
      return await onSchedule(input);
    },
  });
}

// ─── submit_plan（编队计划） ──────────────────────────────

const submitPlanParams = z.object({
  goal: z.string().describe("本次编队的整体目标"),
  acceptance: z.string().optional().describe("整体验收标准"),
  steps: z.array(z.object({
    id: z.string(),
    title: z.string(),
    employee: z.string().describe('执行者员工 id；填 "temp" 表示现招一个一次性临时工（需同时给 temp 规格）'),
    temp: z.object({
      role: z.string().describe("角色一句话，如「接口签名收集员」"),
      prompt: z.string().optional().describe("系统提示词，缺省由 role 生成"),
      tools: z.array(z.string()).optional().describe("工具白名单，缺省只读工具集"),
      model: z.string().optional(),
      maxTurns: z.number().int().optional(),
    }).optional().describe('employee="temp" 时的临时工规格；用完即弃，不能当评审人'),
    brief: z.string().describe("给执行者的任务简报。可用占位 {{input}} / {{step:<前序id>}} / {{step:<id>.<字段名>}}"),
    reviewer: z.string().optional().describe("评审人员工 id"),
    accept: z.string().optional().describe("验收标准"),
    maxRetries: z.number().int().optional(),
    maxTurns: z.number().int().optional().describe('覆盖本步 maxTurns（仅 employee="lead" 的自执行步生效）'),
    produces: z.object({
      files: z.array(z.string()).optional()
        .describe('本步必须产出的文件（相对工作目录，支持 glob 如 "src/*.ts"）'),
      data: z.record(z.string(), z.string()).optional()
        .describe('本步必须给出的关键信息：{ 字段名: "字段含义" }，下游可用 {{step:<id>.<字段名>}} 引用'),
    }).optional().describe("产出合约：声明后系统会自动校验，缺失则让执行者补齐"),
    needs: z.array(z.string()).optional()
      .describe("依赖的上游步骤 id：启动前校验上游合约，执行者运行中可用 reject_upstream 向上游反馈"),
  })).min(1),
});

export type SubmitPlanHandler = (plan: z.infer<typeof submitPlanParams>) => Promise<string>;

export function buildSubmitPlanTool(onSubmitPlan: SubmitPlanHandler) {
  return tool({
    description:
      "提交编队执行计划。选人、排步骤、给验收标准。提交后系统按步骤委派执行。",
    inputSchema: submitPlanParams,
    execute: async (input) => {
      return await onSubmitPlan(input);
    },
  });
}

// ─── reject_upstream（步骤间对话：向上游反馈） ───────────

const rejectUpstreamParams = z.object({
  stepId: z.string().describe("要反馈的上游步骤 id（plan 里的 step id）"),
  reason: z.string().describe("具体问题描述：缺什么、哪里不对、期望什么"),
});

export type RejectUpstreamHandler = (input: z.infer<typeof rejectUpstreamParams>) => Promise<string>;

/**
 * reject_upstream 工具：编队步骤间对话。
 * 下游 agent 在执行中发现上游产出有问题时调用。
 * handler 由引擎注入——暂停当前步骤、resume 上游 session 处理反馈、
 * 上游回复作为本工具的 result 返回给当前 agent（上下文保持连续）。
 */
export function buildRejectUpstreamTool(handler: RejectUpstreamHandler) {
  return tool({
    description:
      "向上游步骤反馈问题。当你发现前序步骤的产出不完整、不正确或缺失关键内容时调用。" +
      "系统会唤醒上游步骤的执行者处理你的反馈，他的回复会作为本工具的返回值给你。" +
      "每个上游步骤只能反馈一次——确认真的有问题再调用，不要用于普通疑问。",
    inputSchema: rejectUpstreamParams,
    execute: async (input) => {
      return await handler(input);
    },
  });
}

// ─── escalate（编队内向组长确认） ─────────────────────────

const escalateParams = z.object({
  question: z.string().describe("要确认的问题，一次只问一件事，写清背景和你倾向的做法"),
  options: z.array(z.string()).min(2).optional()
    .describe("候选处理方式（有就给，组长能直接挑一个，比开放式提问快得多）"),
  blocking: z.boolean().optional()
    .describe("true = 拿不到答复就没法正确往下做（组长会当场作答）；false/缺省 = 不阻塞，记为待组长收尾表态"),
});

export type EscalateHandler = (input: z.infer<typeof escalateParams>) => Promise<string>;

/**
 * escalate 工具：编队内部委派的员工向**组长**确认（不是向用户）。
 *
 * 存在的理由：员工与用户之间没有通道（渠道 chatId 属于老板），所以协议一直禁止员工提问；
 * 但原来给的替代方案只是"把【需澄清】写在返回文本里"——无结构、无强制、无人消费。
 * 这个工具把那条路变成引擎认识的信号：blocking 的当场找组长要答复，
 * 非 blocking 的记进步骤产出，收尾阶段强制组长逐条表态（他判不了再上抛给老板）。
 */
export function buildEscalateTool(handler: EscalateHandler) {
  return tool({
    description:
      "向组长确认一件事。你和最终用户之间没有通道，需要拍板的事一律走这里，不要写在正文里等人看见。" +
      "blocking=true 时系统会当场找组长要答复并作为本工具返回值给你；" +
      "blocking=false 时记录下来由组长在收尾阶段表态，你先按自己的最佳判断继续并在产出里说明假设。" +
      "只用于真需要别人拍板的事（改哪个包、要不要顺带修、两个方案取舍），不要用于自己查得到的问题。",
    inputSchema: escalateParams,
    execute: async (input) => {
      return await handler(input);
    },
  });
}
