import { tool } from "ai";
import { z } from "zod";
import { readFileSync } from "node:fs";
import type { ChannelMessage } from "../../channels/types.js";
import type { BaseAgent } from "../../agents/base-agent.js";
import type { Task } from "../types.js";
import { taskManager as tm } from "../task-manager.js";
import { employeeDisplayName } from "../persona.js";
import { sopRoutingBrief } from "../../core/sop.js";
import { READONLY_TOOLS } from "../../tools/catalog.js";
import {
  buildGetTaskRecordTool,
  buildSearchTaskHistoryTool,
} from "../../runtime/tools/task-history.js";
import {
  opAnswerEmployeeQuestion,
  opCancelTask,
  opContinueTask,
  opDispatchTask,
  opHireTempWorker,
  opRetryTask,
} from "../boss.js";
import {
  createSchedule,
  describeTiming,
  getSchedule,
  listSchedules,
  removeSchedule,
  updateSchedule,
} from "../../scheduler/schedule-store.js";
import {
  applyProposal,
  getProposal,
  pendingProposalsBrief,
  rejectProposal,
  revertProposal,
} from "../proposals.js";
import { config } from "../../config/index.js";
import {
  applyStoredTeamImport,
  clearPendingTeamImport,
  confirmTeamImport,
  createTeamExport,
  createTeamImport,
  getPendingTeamImport,
  prepareStoredTeamImportPlan,
  rollbackTeamImport,
  setPendingTeamImport,
} from "../../team-bundle/store.js";
import type { TeamImportMode } from "../../team-bundle/types.js";
import { deliver } from "../delivery.js";
import { appendBossBroadcast } from "../boss-agent.js";
import { publishStateChange } from "../event-bus.js";
import {
  captureTopic,
  enterThinkingMode,
  exitThinkingMode,
  readTopic,
  renderTopicDigest,
} from "../thinking-store.js";

function explicitTeamImportConfirmation(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");
  if (/[?？]/.test(normalized) || /(为什么|会不会|是否|有什么|区别|影响|风险)/.test(normalized)) {
    return false;
  }
  return /(确认|开始|执行|导入|添加|只加|合并|整体覆盖|全部)/.test(normalized);
}

/**
 * 整体覆盖的**专用**确认判定：必须在用户原话里出现覆盖类措辞。
 *
 * 与上面那个通用判定分开，是因为覆盖是这套流程里唯一会**删除**本地资产的模式
 * （团队包里没有的员工 / Skill / MCP 都会消失）。一句泛泛的「确认」「开始吧」
 * 足够启动添加或合并，但不足以授权删除——用户说「确认」时想的很可能只是「导入吧」。
 */
function explicitReplaceConfirmation(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");
  if (/[?？]/.test(normalized)) return false;
  return /(整体覆盖|全部覆盖|覆盖团队|覆盖现有|替换团队|全量替换|删掉现有|清空再导)/.test(normalized);
}

/**
 * Boss 的工具集（agent 模式）。
 *
 * 设计要点：
 * - 工具**只做事、不发消息**。boss 自己的文本输出是唯一面向用户的回复，
 *   工具再发一条会变成双消息。工具的返回值是给模型看的执行回执。
 * - `answer_employee_question` **仅在存在 waiting_user 任务时注册**：
 *   没人在等的时候这个工具压根不存在，该类误判结构性不可能发生。
 * - boss **不持有**文件/命令类工具。它想自己干活也干不了，只能派活——
 *   这是防人格漂移最硬的保证（提示词会被注意力稀释，能力缺失不会）。
 */

export interface BossToolContext {
  msg: ChannelMessage;
  candidates: BaseAgent[];
  /** 本轮开始时处于 waiting_user 的任务（决定是否注册转达工具） */
  waiting: Task[];
  /** 记录本轮实际发生的动作，供交付守卫判断「说了做没做」 */
  onAction: (action: string) => void;
}

export function buildBossTools(ctx: BossToolContext) {
  const { msg, candidates, waiting, onAction } = ctx;

  const roster = candidates
    .map((a) => {
      // 影分身标注：boss 得知道谁能同时接多件活，否则会按「一人一次一件」的旧认知
      // 对用户说「他正忙、排队」——而对方其实还有空的分身位。串行岗位不加，免噪音。
      const clones = a.profile.maxParallel ?? 1;
      const cloneTag = clones > 1 ? `【影分身 ×${clones}：最多可同时接 ${clones} 件活】` : "";
      return `${a.name}（${employeeDisplayName(a.name)}）：${cloneTag}${a.routeHint ?? a.description ?? ""}`;
    })
    .join("\n");
  const pendingTeamImportId = getPendingTeamImport(msg.chatId);

  /** 该定时任务是否属于当前会话（跨会话一律按「不存在」处理，见 notFoundSchedule） */
  const ownsSchedule = (scheduleId: string): boolean =>
    getSchedule(scheduleId)?.chatId === msg.chatId;

  /**
   * 「找不到」的统一话术：**存在但不属于本会话**时也走这条，不能说成「这条不属于你」——
   * 那等于承认它存在，把别的群/私聊有哪些定时任务泄露出去。
   * 代价是不好排查，所以在服务端留一行日志兜住可观测性。
   */
  const notFoundSchedule = (scheduleId: string): string => {
    if (getSchedule(scheduleId)) {
      console.warn(
        `[boss] 拒绝跨会话操作定时任务 #${scheduleId}（请求来自 chat=${msg.chatId}）`,
      );
    }
    return `没找到定时任务 #${scheduleId}（本会话内没有这条）。请如实告诉用户。`;
  };

  const tools: Record<string, unknown> = {
    export_team_config: tool({
      description: [
        "导出可分享的团队配置文件。用户说『导出/分享团队』『导出某几个员工』时调用。",
        "这是只读操作，可以直接执行。包中永远不包含模型、Provider、Token、Key、本机路径、会话或任务数据。",
        "agentIds 留空表示完整正式员工团队；指定员工时会自动带上他们依赖的用户 Skill/MCP。",
      ].join("\n"),
      inputSchema: z.object({
        name: z.string().optional().describe("导出的团队名称，可不填"),
        agentIds: z.array(z.string()).optional().describe("只导出的员工路由 id；留空导出完整团队"),
        includeBoss: z.boolean().optional().describe("是否包含 Boss 人设；完整团队默认包含，指定员工默认不包含"),
        includeSkills: z.boolean().optional().describe("是否包含员工依赖的用户 Skill，默认 true"),
        includeMcps: z.boolean().optional().describe("是否包含 MCP 结构，默认 true；凭据值永不包含"),
      }),
      execute: async ({ name, agentIds, includeBoss, includeSkills, includeMcps }) => {
        const kind = agentIds?.length ? "employees" as const : "full" as const;
        const record = createTeamExport({
          kind,
          ...(name ? { name } : {}),
          ...(agentIds?.length ? { agentIds } : {}),
          ...(includeBoss != null ? { includeBoss } : {}),
          ...(includeSkills != null ? { includeSkills } : {}),
          ...(includeMcps != null ? { includeMcps } : {}),
        });
        onAction("export_team_config");
        const relative = `/api/console/team-bundles/exports/${record.id}/download`;
        const base = config.publicBaseUrl?.replace(/\/+$/, "");
        const url = base ? `${base}${relative}` : relative;
        const literals = record.summary.carriedLiterals ?? [];
        // 「不含任何值」是句假话：MCP 的公开常量会原样带走。boss 必须能如实说出来，
        // 否则用户会以为包里什么值都没有，也就不会去核对那份清单。
        const literalLines = literals.length
          ? [
              `⚠️ 有 ${literals.length} 项 MCP 公开常量会**原样**写进包里（系统判定为非凭据）：`,
              ...literals.slice(0, 5).map((l) => `  · ${l.mcp}.${l.target}.${l.key} = ${l.value.slice(0, 40)}`),
              ...(literals.length > 5 ? [`  · …还有 ${literals.length - 5} 项，完整清单见管理后台导出向导`] : []),
              "请让用户确认这些都不是凭据；若其中有敏感值，让他改成 ${VAR} 形式后重新导出。",
            ]
          : [];
        return [
          `团队配置已导出：${record.filename}`,
          `包含 ${record.summary.agents} 名员工、${record.summary.skills} 个 Skill、${record.summary.mcps} 个 MCP 定义。`,
          "不包含模型、Provider、Token、Key、本机路径或运行数据；MCP 的凭据只带占位符、不带值。",
          ...literalLines,
          `下载：${url}`,
          ...(!base ? ["当前未配置 publicBaseUrl；外部聊天中若链接打不开，请到管理后台下载。"] : []),
          ...(record.summary.warnings.length ? [`安全处理：${record.summary.warnings.join("；")}`] : []),
        ].join("\n");
      },
    }),

    rollback_team_import: tool({
      description: "回滚一次团队导入。只有用户明确要求按某个快照回滚时调用；回滚前系统还会再建一个安全快照。",
      inputSchema: z.object({ snapshotId: z.string().describe("导入结果返回的回滚快照 id") }),
      execute: async ({ snapshotId }) => {
        const result = rollbackTeamImport(snapshotId);
        onAction("rollback_team_import");
        return `已回滚到快照 ${snapshotId}。回滚前状态也已保存为安全快照 ${result.safetySnapshotId}。请告诉用户。`;
      },
    }),

    dispatch_task: tool({
      description: [
        "派新活给同事。用户提出需要**新工作**的诉求时调用（要产出、要动手、要查你不知道的信息）。",
        "只要调用了本工具，任务就真的建好并开始执行了——不要只在回复里说「我安排了」而不调本工具。",
        "agent 不确定时留空，我会按职责自动选人；用户点名了某位同事则必须填他的路由名。",
        "**brief 必须是用户要的终态**：不许为了迁就名册里现有的人，把诉求缩小成只读的半截活（如把「更新这份线上文档」写成「先起草一份草稿」）。",
        "**不许为了凑现有员工的能力把一件活拆成两个任务**；任务本身有先后依赖（B 要等 A 的产出）时用 afterTask 排序才是正常做法。",
        "没人能把这活**干完整**（典型：只读岗能查能写稿，但没人有权限落地最后那步）→ 别派：单步能交的改调 hire_temp_worker 现招带写权限的临时工；必须多步接力、现有员工又覆盖不了的，派给 `hr` 建岗（他交付的是待批准的提案，不是把活干完，要如实告诉用户）。",
        "",
        "**排顺序**：要「等某个任务干完再做这件事」时填 afterTask。它可以指向**正在跑**的任务——",
        "所以「刚派了 A，又想起有件事要等 A 干完」这种情况直接派新任务 + 填 afterTask 就行。",
        "顺序只需在这里写一次：前置一结束，系统会自动验收它并接着派这个任务，**你不用记着这件事，",
        "也不要让用户回头提醒你**。若链路一开始就已知且有 3 步以上，改派 lead 走编队，别用 afterTask 手搓长链。",
        "",
        "**验收**：acceptance 写清什么样算做完。其中**能机验的部分**（该产出哪些文件）填到 contract.files——",
        "那会用 fs 真查文件是否存在，比任何文字判断都可靠（员工说「已写入 x.md」而文件不在，会被直接判未完成）。",
        "reviewer 只在用户明确要质量把关时填，平时留空（岗位配置里声明了评审人的会自动走）。",
        "",
        "同事名册：",
        roster,
        // SOP 段只在派工这一刻需要，不必占每轮 system prompt
        sopRoutingBrief(),
      ]
        .filter(Boolean)
        .join("\n"),
      inputSchema: z.object({
        brief: z
          .string()
          .describe(
            "给员工的派工简报，三行式：目标：… / 关键信息：…（用户消息里的路径、仓库、分支、报错原样罗列，一字不改）/ 验收：…（什么样算做完）",
          ),
        agent: z
          .string()
          .optional()
          .describe("目标同事的路由名（名册里的 name）。不确定就留空由系统选人"),
        clarify: z
          .string()
          .optional()
          .describe(
            "诉求太模糊、**写不出验收标准**时填这里：一句话问用户缺的那个关键点。任务会挂起等他回答，不会瞎派下去；他答完自动继续派工，你不用记着这件事",
          ),
        afterTask: z
          .string()
          .optional()
          .describe(
            "前置任务号（如 #12 或 12，同一会话内）：本任务排在它之后，等它结束再自动开跑。可以指向正在跑的任务",
          ),
        acceptance: z
          .string()
          .optional()
          .describe("验收标准，什么样算做完。会在验收时被逐条核对，比写在 brief 里更硬"),
        contract: z
          .object({
            files: z
              .array(z.string())
              .optional()
              .describe("必须产出的文件路径（相对员工工作目录，支持 * / ** 通配）"),
          })
          .optional()
          .describe("可机验的产出：会用 fs 真查，文件不存在直接判未完成，不经过任何模型判断"),
        reviewer: z
          .string()
          .optional()
          .describe("本次指定的评审人路由名（一次性，不改岗位配置）。用户明确要质量把关时才填"),
      }),
      execute: async ({ brief, agent, clarify, afterTask, acceptance, contract, reviewer }) => {
        let out: Awaited<ReturnType<typeof opDispatchTask>>;
        try {
          out = await opDispatchTask({
            msg,
            content: brief,
            candidates,
            ...(agent ? { agent } : {}),
            // clarify 需要一个占位承接人（真正的人选在用户答复后重新路由）
            ...(clarify ? { clarify, agent: agent ?? candidates[0]?.name } : {}),
            brief,
            ...(afterTask ? { afterTask } : {}),
            ...(acceptance ? { acceptance } : {}),
            ...(contract ? { contract } : {}),
            ...(reviewer ? { reviewer } : {}),
          });
        } catch (error) {
          // 顺序声明不合法等：把原因回给模型让它改，别让它以为已经安排上了
          return `派工没成功：${error instanceof Error ? error.message : String(error)}\n请据此纠正后重试，或如实告诉用户。`;
        }
        if (out.state === "waiting_clarify") {
          onAction("dispatch_task");
          return `派工前需要先跟用户确认方向（任务 #${out.taskId} 已挂起）：${out.clarify}\n请把这个问题转达给用户。`;
        }
        // 讨论已收敛成活 → 当前工作面结束，摘要全文不必继续常驻（索引仍在，随时可 read_thinking 捞回）。
        // waiting_clarify 刻意不退：那说明还在确认方向，讨论没结束。
        exitThinkingMode(msg.chatId);
        onAction("dispatch_task");
        if (out.state === "running") {
          return `已建任务 #${out.taskId} 并派给「${out.displayName}」，现在开始执行。请把这件事告诉用户（带上任务号）。`;
        }
        if (out.state === "waiting_dep") {
          return (
            `已建任务 #${out.taskId} 派给「${out.displayName}」，排在 #${out.afterTask} 之后——` +
            `等它结束我会自动验收并接着派这个，你不用再管。请如实告诉用户这个顺序。`
          );
        }
        const busyIds = out.busyWithTaskIds ?? [];
        const busyText =
          busyIds.length > 1
            ? `他手上同时有 ${busyIds.length} 件活（${busyIds.map((id) => `#${id}`).join(" ")}）、槽位已满`
            : `他正忙（在处理 #${busyIds[0] ?? "?"}）`;
        return `已建任务 #${out.taskId} 派给「${out.displayName}」，但${busyText}，排队中${out.aheadCount ? `，前面还有 ${out.aheadCount} 个` : ""}。请如实告诉用户在排队。`;
      },
    }),

    continue_task: tool({
      description: [
        "让某位同事**接着他刚做过的工作**继续做（延续/追加/修改），会沿用他的上下文。",
        "适用：用户对某个刚交付的结果提出调整（如刚做完页面，说「把按钮调成蓝色」）。",
        "如果是全新的、与近期工作无关的诉求，用 dispatch_task。",
        "",
        "**同事可能同时在做多件活**（开了并发槽的岗位）。这时必须带上 taskId 指明续哪一件；",
        "不带的话本工具会把候选列出来让你回头问用户，**不要自己替用户挑一个**——",
        "挑错要么打断了另一件正在跑的活，要么把用户的话塞给了另一个问题，而用户看不出发生了什么。",
      ].join("\n"),
      inputSchema: z.object({
        agent: z.string().describe("同事的路由名"),
        content: z.string().describe("要他接着做什么（保留用户原话里的关键信息）"),
        taskId: z
          .string()
          .optional()
          .describe("要延续的那个任务号（不带 #）。他手上同时有多件活时必填；用户明确说了任务号时也应带上"),
      }),
      execute: async ({ agent, content, taskId }) => {
        const out = await opContinueTask({
          msg,
          agentName: agent,
          content,
          candidates,
          ...(taskId ? { taskId: taskId.replace(/^#/, "") } : {}),
        });
        if ("invalidAgent" in out) {
          return `没有「${agent}」这位同事（或他不可派活）。请改用名册里的路由名，或用 dispatch_task 让系统选人。`;
        }
        if ("ambiguous" in out) {
          const lines = out.candidates.map(
            (c) => `- #${c.taskId}（${c.state}）：${c.summary}${c.question ? `\n  └ 正在等用户回答：${c.question}` : ""}`,
          );
          return [
            `「${out.displayName}」手上同时有 ${out.candidates.length} 件活，无法判断用户指的是哪一件：`,
            ...lines,
            "",
            "请回头问用户是哪一个（把任务号和一句话说明列给他），拿到答复后再带 taskId 调一次本工具。",
            "**不要自己猜一个**，也不要假装已经派下去了。",
          ].join("\n");
        }
        onAction("continue_task");
        if (out.redirected === "answered_waiting") {
          return `注意：「${out.displayName}」当时正停下来等用户回答，你这条内容已被当作那个问题的答复转达给他，任务 #${out.taskId} 继续执行。请据实告诉用户。`;
        }
        if (out.redirected === "interrupted_running") {
          return `已打断「${out.displayName}」手头的动作，让他按新指示继续任务 #${out.taskId}。请告诉用户。`;
        }
        return out.state === "running"
          ? `已让「${out.displayName}」接着做（任务 #${out.taskId}${out.resumedContext ? "，沿用了之前的上下文" : ""}）。请告诉用户。`
          : `已排队（任务 #${out.taskId}），「${out.displayName}」正忙，轮到时会接着之前的上下文继续。请如实告诉用户在排队。`;
      },
    }),

    retry_task: tool({
      description: [
        "重试一个已经失败的任务，沿用原任务号和可用的 session 上下文。",
        "用户说『重试/再试一次/继续刚才失败的 #任务』时用这个；不要用 continue_task 新建任务。",
        "只适用于 failed 状态；运行中或已完成任务不要调用。",
      ].join("\n"),
      inputSchema: z.object({
        taskId: z.string().describe("失败任务号（不带 #）"),
      }),
      execute: async ({ taskId }) => {
        const out = opRetryTask(msg, taskId);
        if (!out.ok) {
          return `任务 #${taskId} 不存在或当前不是失败状态，不能原地重试。请先核对任务状态。`;
        }
        onAction("retry_task");
        const revivedNote = out.revived
          ? "（原临时工已过期清理，已从归档复活，将按原始需求从头执行）"
          : "";
        return out.state === "running"
          ? `已在原任务 #${out.taskId} 上让「${out.displayName}」重试${revivedNote}${out.resumedContext ? "，并沿用已保存的上下文" : "；会话存档缺失，已附带原始需求兜底"}。请告诉用户。`
          : `原任务 #${out.taskId} 已重新排队${revivedNote}，轮到「${out.displayName}」时继续，不会新建任务。请如实告诉用户。`;
      },
    }),

    cancel_task: tool({
      description:
        "取消一个任务。用户要求取消/撤掉/终止/不用做了时**必须调用本工具**——只在回复里说「已取消」是谎报，任务会一直留在队列里。",
      inputSchema: z.object({
        taskId: z.string().describe("要取消的任务号（不带 # 号）"),
      }),
      execute: async ({ taskId }) => {
        const out = opCancelTask(msg, taskId);
        onAction("cancel_task");
        return out.ok
          ? `已真正取消任务 #${out.taskId}。请告诉用户。`
          : `没找到可取消的任务 #${taskId}（可能已结束或任务号不对）。请如实告诉用户，不要声称已取消。`;
      },
    }),

    hire_temp_worker: tool({
      description: [
        "**没有同事能把这活干完整**时，现招一个临时工来做——这是你「自己来」的方式，因为你自己没有动手能力。",
        "先确认真的无人可派：名册里有对口的人，一律用 dispatch_task 派给他，招人是最后手段。",
        "但「有人沾得上边」不等于「有人能干」：最典型的一种是只读岗能查能起草、却没人有权限落地最后那步——",
        "这时就该招一个带写权限的临时工，**不要**把活缩小成只读的半截交出去。",
        "",
        "**权限按需给**（不再限于只读）：",
        "· 查阅 / 检索 / 汇总 / 比对这类 → 不填 tools，他默认只读。",
        "· 要改文件 / 跑命令 / 跑构建 → tools 里加 Write、Edit、Bash，**同时必须填 readRoots**",
        "  （这次要碰哪些目录）。不填 readRoots 会被代码拒绝——门禁只在声明后才启用。",
        "· 要**多步接力（SOP 型）**的你招不了：派给 `hr` 设计岗位——注意他交付的是**待用户批准的建岗提案**，不是把活干完，要如实这么告诉用户。",
        "",
        "**写入范围是硬的**：他只能写自己的工作目录，改真实仓库要在工作目录里 clone、",
        "改完 push 工作分支（主干被门禁挡住）。readRoots 只放开**读**。告诉用户时别说过头。",
        "",
        "**brief 里带阶段性确认时**（先出草稿 / 先只汇报，用户点头再落地）：必须在 systemPrompt 里交代他——",
        "第一阶段做完**用提问工具把成果贴出来等回话，不要交卷**。交卷会终结他的会话，",
        "后续阶段就得重新开一个人从零把数据重查一遍。",
        "**后续阶段一律用 continue_task 续派给他本人**（用他的 id），不要重招：",
        "同一会话里、同能力域、且他手上已经没活时，重招会被直接拒掉。",
        "",
        "同一类活之前招过人也照常招，不必犹豫：同类需求反复出现不是错误，而是「该设个正式岗位」的信号，",
        "系统会自己统计并在够次数时让 hr 提建岗提案。临时工用完即释放，不进经验库、不进路由名册。",
      ].join("\n"),
      inputSchema: z.object({
        capability: z
          .string()
          .max(20, "capability 超过 20 字——太具体了，把本次的仓库/平台/文件焊了进去（这是分桶 key，短才容易撞桶）")
          .describe(
            "**能力域**（不是这一次的活）：**这是给计数分桶用的 key**——同一能力域下次再出现时你必须写**一模一样**才算数，" +
              "字面不同就是新桶，归纳永远触发不了。写之前先做一次自检：**下次遇到相似的活，我还会写一样吗？**\n" +
              "写法要求：\n" +
              "- **短**（≤16 汉字），动宾结构，一句表达一类活，不要堆修饰；\n" +
              "- **讲能力不讲品牌 / 平台**：写「在线协作文档的读写」，别写「语雀 / 钉钉文档 / 在线表格」；\n" +
              "- **不要罗列**（不写括号里的枚举）、**不要焊本次细节**（仓库名 / 路径 / 页面名进 brief，不进这里）；\n" +
              "- 拿不准就写更粗一档——粗一点会被 hr 归纳时细化，写太细则永远凑不到 3 条。\n" +
              "正例：「在线协作文档的读写」「接口定义类文档的检索与汇总」「CSV/表格数据的汇总整理」。\n" +
              "反例：「整理 order-service 的 v2 接口」（焊死本次）、" +
              "「线上协作文档（语雀 / 钉钉、在线表格）的读写与更新」（罗列平台 + 副词堆叠 → slug 与「在线文档读写」凑不到一起）、" +
              "「日报老页面迁移进展章节的更新」（本次任务名）",
          ),
        description: z.string().describe("一句话职责：他负责干什么"),
        systemPrompt: z
          .string()
          .describe(
            "给他的系统提示词，**面向能力域写**（别把这次的仓库名/路径/文件名焊进去，那些放 brief）：" +
              "说清他的身份、要产出什么、判断口径。他看不到你和用户的对话，别假设他「知道」背景",
          ),
        brief: z
          .string()
          .describe("交给他的这件事，三行式：目标：… / 关键信息：…（路径、仓库、报错原样罗列）/ 验收：…"),
        tools: z
          .array(z.string())
          .optional()
          .describe(
            `工具白名单，不填=只读（${READONLY_TOOLS.join(", ")}）。要动手就加 Write / Edit / Bash（加了必须给 readRoots）`,
          ),
        readRoots: z
          .array(z.string())
          .optional()
          .describe(
            "他这次能**读**的目录绝对路径（如 /Users/x/repo、~/Downloads）。给了高权限工具时必填；" +
              "不能填 / 或整个家目录，也不能填本服务自己的目录",
          ),
        maxTurns: z
          .number()
          .int()
          .optional()
          .describe(
            "这件活的步数额度，按实际规模给（缺省：只读 30 / 可动手 60，上限 80）。" +
              "要翻很多文件、或要反复「改 → 跑 → 看结果」的活往上调；一两步就能交的小事不必填",
          ),
      }),
      execute: async ({ capability, description, systemPrompt, brief, tools, readRoots, maxTurns }) => {
        const out = opHireTempWorker({
          msg,
          capability,
          description,
          systemPrompt,
          brief,
          ...(tools?.length ? { tools } : {}),
          ...(readRoots?.length ? { readRoots } : {}),
          ...(maxTurns ? { maxTurns } : {}),
        });
        if (!out.ok) return `没招成——${out.reason}\n请如实告诉用户，不要声称已经安排了人。`;
        onAction("hire_temp_worker");
        return (
          `已招临时工「${out.displayName}」（${out.agentName}）并把活交给他，任务 #${out.taskId} 开始执行。` +
          `请告诉用户：这是临时工、干完即释放，以及他拿到的是${out.highPriv ? `可动手权限（${out.highPriv}），写入限于他自己的工作目录` : "只读权限"}。`
        );
      },
    }),

    list_tasks: tool({
      description: "查看本会话的任务清单与状态。回答「我的任务好了吗」「现在在跑什么」这类问题时用。",
      inputSchema: z.object({}),
      execute: async () => {
        const active = tm.activeTasks(msg.chatId);
        // 快照里排除定时任务只为不挤占用户任务的槽位；这里是「按需查全量」的出口，要看得到
        const finished = tm.recentFinishedTasks(msg.chatId, 5, { includeScheduled: true });
        if (!active.length && !finished.length) return "本会话目前没有任何任务。";
        const fmt = (t: Task) => {
          const head = `#${t.id} [${t.state}]${t.scheduled ? " ⏰定时" : ""} ${employeeDisplayName(t.agentName)}：${t.prompt.slice(0, 50)}`;
          if (t.state === "waiting_user" && t.question) {
            return `${head}\n  └ 正在等用户回答：${t.question.slice(0, 120)}`;
          }
          const detail = t.state === "failed" ? t.error || t.result : t.result;
          return detail ? `${head}\n  └ 结论：${detail.slice(0, 200)}` : head;
        };
        return [
          active.length ? `进行中：\n${active.map(fmt).join("\n")}` : "没有进行中的任务。",
          finished.length ? `最近收尾：\n${finished.map(fmt).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      },
    }),

    get_task_detail: tool({
      description:
        "取某个任务的完整结论原文。用户追问已交付结果的细节、或问某任务为什么失败时用——**以这里的原文为准，不要凭印象作答**。",
      inputSchema: z.object({
        taskId: z.string().describe("任务号（不带 # 号）"),
      }),
      execute: async ({ taskId }) => {
        const t = tm.get(msg.chatId, taskId);
        if (!t) return `没找到任务 #${taskId}。`;
        return [
          `任务 #${t.id}（${employeeDisplayName(t.agentName)}）状态：${t.state}`,
          `原始诉求：${t.prompt}`,
          t.question ? `正在等用户回答：${t.question}` : "",
          t.result ? `结论：\n${t.result}` : "",
          t.error ? `失败原因：${t.error}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    }),

    search_task_history: buildSearchTaskHistoryTool(),
    get_task_record: buildGetTaskRecordTool(),

    create_schedule: tool({
      description: [
        "创建定时任务。用户要「每天/每周/每隔多久让某同事做某事」或「N 分钟后做某事」时用。",
        "**agentName 必须是名册里现有、能把这活干完整的正式员工**：定时任务会重复触发，每次触发派不出人会被直接跳过。",
        "临时工在这里**用不了**：他是任务级的（用完释放 / TTL 到期释放），下一次触发时他早不在了。",
        "**名册里没人对口时不要直接建定时**，也不要在 prompt 里写「先招个人再做」——先用 dispatch_task 派给 `hr` 建岗，" +
          "brief 里点明「用于定时任务、独立触发无对话历史、需要什么工具/权限」。你批准落盘后，我再回来 create_schedule 挂给他。",
      ].join("\n"),
      inputSchema: z.object({
        title: z.string().describe("一句话任务名，如「每日复盘」"),
        agentName: z.string().describe("负责的同事路由名"),
        prompt: z.string().describe("到时候要做什么（写清目标与产出，那时是全新会话）"),
        timing: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("once"), atMs: z.number() }),
            z.object({ kind: z.literal("daily"), hour: z.number(), minute: z.number() }),
            z.object({
              kind: z.literal("weekly"),
              weekday: z.number().describe("0=周日"),
              hour: z.number(),
              minute: z.number(),
            }),
            z.object({ kind: z.literal("interval"), everyMs: z.number().describe("最小 60000") }),
          ])
          .describe("触发规则"),
      }),
      execute: async ({ title, agentName, prompt, timing }) => {
        const created = createSchedule({
          title,
          agentName,
          prompt,
          timing,
          channel: msg.channel,
          chatId: msg.chatId,
          chatType: msg.chatType,
          ownerSenderId: msg.senderId,
          ownerSenderName: msg.senderName ?? "",
          createdBy: "boss",
        });
        if ("error" in created) return `创建失败：${created.error}。请如实告诉用户。`;
        onAction("create_schedule");
        const s = created.schedule;
        return `已创建定时任务 #${s.id}「${s.title}」${describeTiming(s.timing)}，由「${employeeDisplayName(s.agentName)}」执行。请告诉用户。`;
      },
    }),

    list_schedules: tool({
      // 措辞必须点明「本会话」：说成「所有」会让模型把这份按会话过滤的结果当成全局权威，
      // 于是用户问「不是还有个 X 吗」时它一口咬定「没有这条」，甚至反问是不是记错了、
      // 提议重建——而那条 X 只是建在另一个会话里，重建就会多出一条重复定时任务。
      // （真实事故：Top10 速报被误报为已取消，成因见 schedule-store 的 normalizePrivateChatIds）
      description: "列出**当前会话**的定时任务（其他会话/群的定时任务不在此列）。",
      inputSchema: z.object({}),
      execute: async () => {
        const all = listSchedules().filter((s) => s.chatId === msg.chatId);
        if (!all.length) return "本会话还没有定时任务（其他会话/群里的不算，这里看不到）。";
        return all
          .map(
            (s) =>
              `#${s.id}「${s.title}」${describeTiming(s.timing)} → ${employeeDisplayName(s.agentName)}${s.enabled ? "" : "（已停用）"}`,
          )
          .join("\n");
      },
    }),

    cancel_schedule: tool({
      description: "取消当前会话的一个定时任务。必须调用本工具，不能只嘴上答应。",
      inputSchema: z.object({ scheduleId: z.string() }),
      execute: async ({ scheduleId }) => {
        // 归属校验与 list_schedules 对齐：读按会话过滤、写却全局可达的话，
        // 别的群/私聊的定时任务会「看不见但能删」——只要 id 从历史或用户嘴里漏进来就能删掉。
        if (!ownsSchedule(scheduleId)) return notFoundSchedule(scheduleId);
        const ok = removeSchedule(scheduleId);
        onAction("cancel_schedule");
        return ok
          ? `已取消定时任务 #${scheduleId}。请告诉用户。`
          : `没找到定时任务 #${scheduleId}。请如实告诉用户。`;
      },
    }),

    resume_schedule: tool({
      description: "恢复当前会话中被停用的定时任务（如连续失败后自动停用的）。",
      inputSchema: z.object({ scheduleId: z.string() }),
      execute: async ({ scheduleId }) => {
        if (!ownsSchedule(scheduleId)) return notFoundSchedule(scheduleId);
        const s = getSchedule(scheduleId)!;
        updateSchedule(scheduleId, { enabled: true, failCount: 0, backoffUntil: undefined });
        onAction("resume_schedule");
        return `已恢复定时任务 #${scheduleId}「${s.title}」。请告诉用户。`;
      },
    }),

    handle_proposal: tool({
      description:
        "处理提示词优化提案：list=看待审清单，apply=批准生效，reject=驳回，revert=回退已生效的提案。",
      inputSchema: z.object({
        op: z.enum(["list", "apply", "reject", "revert"]),
        proposalId: z.string().optional().describe("apply/reject/revert 时必填"),
      }),
      execute: async ({ op, proposalId }) => {
        if (op === "list") return pendingProposalsBrief() ?? "当前没有待审的优化提案。";
        if (!proposalId) return "要指明提案号才能操作。";
        onAction(`proposal_${op}`);
        if (op === "apply") {
          const r = applyProposal(proposalId);
          return r.ok ? `已批准：${r.message}（下次派活生效）` : `批准失败：${r.message}`;
        }
        if (op === "reject") {
          const p = getProposal(proposalId);
          return `${rejectProposal(proposalId).message}${p ? `（目标员工 ${p.agentId}）` : ""}`;
        }
        return revertProposal(proposalId).message;
      },
    }),
  };

  const teamAttachments = (msg.attachments ?? []).filter((a) =>
    a.name.toLowerCase().endsWith(".ait-team"),
  );
  if (teamAttachments.length > 0) {
    tools.inspect_team_config = tool({
      description: [
        "检查用户本轮上传的 .ait-team 团队包，只生成预览和冲突方案，绝不修改配置。",
        "收到团队包时必须先调用本工具；即使用户说『直接覆盖』，这一轮也只能检查，下一轮明确确认后才能应用。",
      ].join("\n"),
      inputSchema: z.object({
        attachmentIndex: z.number().int().min(1).max(teamAttachments.length).default(1),
      }),
      execute: async ({ attachmentIndex }) => {
        const attachment = teamAttachments[attachmentIndex - 1];
        const created = createTeamImport(readFileSync(attachment.path), attachment.name);
        setPendingTeamImport(msg.chatId, created.record.id);
        onAction("inspect_team_config");
        const inspection = created.inspection;
        const pkg = inspection.package;
        return [
          `已安全检查团队包「${pkg.meta.name}」，尚未修改任何配置。`,
          `内容：${pkg.boss ? "Boss 人设；" : ""}${pkg.agents.length} 名员工、${pkg.skills.length} 个 Skill、${pkg.mcps.length} 个 MCP。`,
          `冲突：员工 ${inspection.conflicts.agents.length}、Skill ${inspection.conflicts.skills.length}、MCP ${inspection.conflicts.mcps.length}。`,
          inspection.requiredBindings.length
            ? `有 ${inspection.requiredBindings.length} 项 MCP 本机绑定需要补齐；模型和凭据不会从包里导入。`
            : "不需要补充 MCP 本机绑定。",
          inspection.errors.length ? `不可导入：${inspection.errors.join("；")}` : "可选择：只添加员工、合并团队、整体覆盖。请让用户明确选择后再应用。",
          `内部导入会话：${created.record.id}`,
        ].join("\n");
      },
    });
  }

  if (pendingTeamImportId) {
    tools.apply_team_config = tool({
      description: [
        "应用上一轮已经检查过的团队包。只有用户这条消息明确确认『添加/合并/整体覆盖』时才能调用。",
        "如果用户是在询问区别、风险、影响或尚未选择模式，不要调用；先直接解释。",
        "模型和 Provider 永远保留本地配置；MCP 凭据不会从包里导入。",
        "**整体覆盖需要用户明确说出覆盖意图**（如「整体覆盖」「替换团队」）——它会删掉包里没有的本地员工、Skill 与 MCP，一句泛泛的「确认」不够。",
      ].join("\n"),
      inputSchema: z.object({
        mode: z.enum(["add_employees", "merge", "replace_team"]).describe("添加员工 / 合并 / 整体覆盖"),
        agentIds: z.array(z.string()).optional().describe("只添加指定员工时填写；不填表示包内全部员工"),
        includeBoss: z.boolean().optional().describe("是否应用包内 Boss 人设"),
        onConflict: z.enum(["keep", "replace"]).default("keep").describe("同名冲突默认保留本地；用户明确说覆盖才选 replace"),
      }),
      execute: async ({ mode, agentIds, includeBoss, onConflict }) => {
        if (!explicitTeamImportConfirmation(msg.text)) {
          return "这条消息不是明确的导入确认，已拒绝应用。请先回答用户的问题，等他明确说添加、合并或整体覆盖。";
        }
        // 覆盖会删本地资产，所以要在用户**原话**里看到覆盖措辞，不接受模型自己推断出的意图
        if (mode === "replace_team" && !explicitReplaceConfirmation(msg.text)) {
          return [
            "整体覆盖已拒绝：用户这条消息里没有明确的覆盖措辞。",
            "整体覆盖会删掉团队包里没有的本地员工、Skill 与 MCP，这是不可逆的资产删除。",
            "请先把这个后果告诉用户，让他明确说出「整体覆盖」或「替换团队」，再重新调用。",
            "如果他其实只想加人，用 add_employees；只想合并，用 merge。",
          ].join("\n");
        }
        prepareStoredTeamImportPlan(pendingTeamImportId, {
          mode: mode as TeamImportMode,
          ...(agentIds?.length ? { agentIds } : {}),
          ...(includeBoss != null ? { includeBoss } : {}),
          onConflict,
        });
        const { token } = confirmTeamImport(pendingTeamImportId, {
          acknowledgeReplace: mode === "replace_team",
        });
        const result = applyStoredTeamImport(pendingTeamImportId, token);
        clearPendingTeamImport(msg.chatId);
        onAction("apply_team_config");
        return [
          `团队配置已应用。新增员工 ${result.addedAgents.length}，更新 ${result.updatedAgents.length}，跳过 ${result.skippedAgents.length}。`,
          `本地模型、Provider 和凭据保持不变。回滚快照：${result.snapshotId}。`,
          result.pendingMcpBindings.length
            ? `还有 ${result.pendingMcpBindings.length} 项 MCP 本机绑定未配置，对应 MCP 暂时不会生效；请到管理后台补齐。`
            : "MCP 不需要补充本机绑定。",
        ].join("\n");
      },
    });

    tools.cancel_team_import = tool({
      description: "取消上一轮待确认的团队导入。用户说不导了、取消时调用。",
      inputSchema: z.object({}),
      execute: async () => {
        clearPendingTeamImport(msg.chatId);
        onAction("cancel_team_import");
        return "已取消这次团队导入，没有修改团队配置。";
      },
    });
  }

  // 只有真的有人在等回答时才注册转达工具。
  // 没人等的时候这个工具不存在 → 「把用户的话误转给员工」结构性不可能发生。
  if (waiting.length > 0) {
    const pending = waiting
      .map((t) => `#${t.id}（${employeeDisplayName(t.agentName)}）在等：${t.question ?? "(待确认)"}`)
      .join("\n");
    tools.answer_employee_question = tool({
      description: [
        "把用户的答复转达给正在等待的同事，让他继续干活。",
        "**只在用户这条消息确实是在回答下面某个待确认问题时才调用。**",
        "如果用户是在提问（尤其是问「为什么…」「刚才那个…」这类关于已发生的事），那不是答复——不要调本工具。",
        "",
        "当前在等回答的同事：",
        pending,
      ].join("\n"),
      inputSchema: z.object({
        taskId: z.string().describe("在等回答的那个任务号（不带 # 号）"),
        content: z
          .string()
          .describe("用户的答复内容（原样转达，不要改写；只放与该问题相关的部分）"),
      }),
      execute: async ({ taskId, content }) => {
        const out = await opAnswerEmployeeQuestion({ msg, taskId, content, candidates });
        if (!out.ok) {
          if (out.reason === "no_fit") {
            return (
              `澄清完仍然没人能干这活（${out.detail}）——占位任务 #${out.taskId} 已取消。\n` +
              `请改用 hire_temp_worker 现招一个临时工，brief 用下面这份合并后的完整诉求：\n${out.brief}`
            );
          }
          return out.reason === "not_found"
            ? `没找到任务 #${taskId}。请核对任务号，或改用其他方式处理这条消息。`
            : `任务 #${taskId} 已经不在等待回答的状态了（可能已收尾或被取消）。不要把它当成待回答的问题——请重新判断这条消息该怎么处理。`;
        }
        onAction("answer_employee_question");
        return `已把答复转达给「${out.displayName}」，任务 #${out.taskId} 继续执行${out.rerouted ? `（据答复重新定向给了 ${out.rerouted}）` : ""}。请告诉用户。`;
      },
    });
  }

  // ─── 系统事件驱动的新工具（单一大脑后 boss 需要这些来处理验收/失败/交接等）──

  tools.notify_user = tool({
    description: [
      "主动向用户推送消息。系统事件唤醒你时，如果需要告知用户某件事（失败、完成、需确认），用这个。",
      "用户消息轮里不要用——那时直接回话就行。",
    ].join("\n"),
    inputSchema: z.object({
      message: z.string().describe("推送给用户的文本（说人话，不要 JSON）"),
    }),
    execute: async ({ message }) => {
      const target = {
        channel: msg.channel,
        chatId: msg.chatId,
        chatType: msg.chatType,
        ownerSenderId: msg.senderId,
      };
      await deliver(target, message);
      appendBossBroadcast(msg.chatId, message);
      onAction("notify_user");
      return "已推送给用户。";
    },
  });

  tools.complete_task = tool({
    description: [
      "验收通过，标记任务完成。系统事件「task_completed」唤醒你后，",
      "如果判断员工产出满足验收标准，调这个把任务标完成并通知用户。",
    ].join("\n"),
    inputSchema: z.object({
      taskId: z.string().describe("任务号"),
      summary: z.string().optional().describe("一句话结论（展示给用户，可选）"),
    }),
    execute: async ({ taskId, summary }) => {
      const task = tm.get(msg.chatId, taskId);
      if (!task) return `任务 #${taskId} 不存在。`;
      if (task.state === "done") return `任务 #${taskId} 已经是完成状态。`;
      const prev = task.state;
      const resultText = summary ?? task.result ?? "(已完成)";
      tm.markDone(msg.chatId, taskId, resultText);
      publishStateChange(task, prev);
      const notification = `✅ 任务 #${taskId}（${employeeDisplayName(task.agentName)}）已完成${summary ? `：${summary}` : ""}`;
      await deliver(
        { channel: msg.channel, chatId: msg.chatId, chatType: msg.chatType, ownerSenderId: msg.senderId },
        notification,
      );
      appendBossBroadcast(msg.chatId, notification);
      onAction("complete_task");
      return `已标记 #${taskId} 完成并通知用户。`;
    },
  });

  tools.fail_task = tool({
    description: [
      "判定任务失败并通知用户。系统事件「task_failed」唤醒你后，",
      "如果判断不值得重试（凭据错误、配置错误等），调这个。",
    ].join("\n"),
    inputSchema: z.object({
      taskId: z.string().describe("任务号"),
      reason: z.string().describe("失败原因（人话，展示给用户）"),
    }),
    execute: async ({ taskId, reason }) => {
      const task = tm.get(msg.chatId, taskId);
      if (!task) return `任务 #${taskId} 不存在。`;
      const prev = task.state;
      tm.markFailed(msg.chatId, taskId, reason);
      publishStateChange(task, prev);
      const notification = `❌ 任务 #${taskId}（${employeeDisplayName(task.agentName)}）失败：${reason}`;
      await deliver(
        { channel: msg.channel, chatId: msg.chatId, chatType: msg.chatType, ownerSenderId: msg.senderId },
        notification,
      );
      appendBossBroadcast(msg.chatId, notification);
      onAction("fail_task");
      return `已标记 #${taskId} 失败并通知用户。`;
    },
  });

  tools.reassign_task = tool({
    description: [
      "换人：取消原任务并以相同诉求重新派给另一位员工。",
      "场景：员工反复失败、声明无法完成、或你判断换人更高效。",
    ].join("\n"),
    inputSchema: z.object({
      taskId: z.string().describe("要换人的任务号"),
      newAgent: z.string().optional().describe("新承接人路由名（不填则由系统选人）"),
      brief: z.string().optional().describe("如需调整诉求可覆写 brief（不填则沿用原 brief）"),
    }),
    execute: async ({ taskId, newAgent, brief }) => {
      const task = tm.get(msg.chatId, taskId);
      if (!task) return `任务 #${taskId} 不存在。`;
      // 取消原任务
      const cancelled = opCancelTask(msg, taskId);
      if (!cancelled) return `取消 #${taskId} 失败（可能已处于终态）。`;
      // 重新派发
      try {
        const result = await opDispatchTask({
          msg,
          content: brief ?? task.brief ?? task.prompt,
          candidates,
          agent: newAgent,
        });
        onAction("reassign_task");
        return `已取消 #${taskId}，重新派给「${result.displayName}」，新任务 #${result.taskId}。`;
      } catch (err) {
        return `已取消 #${taskId}，但重新派发失败：${err instanceof Error ? err.message : String(err)}。请手动处理。`;
      }
    },
  });

  tools.send_feedback = tool({
    description: [
      "向员工发送追问/返工指示，让他在原任务上继续。",
      "场景：验收未通过，需要告诉他哪里不对、怎么改。",
    ].join("\n"),
    inputSchema: z.object({
      taskId: z.string().describe("任务号"),
      feedback: z.string().describe("具体的反馈/返工指示（要具体，别笼统）"),
    }),
    execute: async ({ taskId, feedback }) => {
      const task = tm.get(msg.chatId, taskId);
      if (!task) return `任务 #${taskId} 不存在。`;
      const result = await opContinueTask({
        msg,
        agentName: task.agentName,
        content: `【主管验收反馈】${feedback}\n\n请据此修正并重新交付。`,
        candidates,
        taskId,
      });
      if ("invalidAgent" in result && result.invalidAgent) {
        return `员工「${task.agentName}」不可用，无法续派。考虑用 reassign_task 换人。`;
      }
      onAction("send_feedback");
      return `已把反馈发给「${employeeDisplayName(task.agentName)}」，#${taskId} 继续执行。`;
    },
  });

  // ─── 脑爆工具（与用户一起想事情时用）──────────────────────

  tools.capture_thinking = tool({
    description: [
      "把脑爆过程中**值得留下的东西**记进话题摘要。你自己判断时机，用户不需要说「记一下」。",
      "",
      "什么时候记（四种里出现任意一种就记）：",
      "- 枚举出了几个方案候选",
      "- 达成了一个结论",
      "- **否掉了某条路，并且有理由**（最不该丢的，务必记）",
      "- 冒出一个悬而未决的问题",
      "",
      "什么时候**不要**记：普通来回、你自己的解释、还没成形的半句话。",
      "这不是速记——记成聊天记录副本反而有害。",
      "",
      "同一话题反复调用是在**更新槽位**（自动去重合并），不会堆成一长串。",
    ].join("\n"),
    inputSchema: z.object({
      topic: z
        .string()
        .describe("话题名，简短稳定（如「缓存方案选型」）。同一场讨论务必用同一个名字，否则攒不到一起"),
      options: z.array(z.string()).optional().describe("新增的方案候选"),
      conclusions: z.array(z.string()).optional().describe("新增的结论"),
      rejected: z
        .array(z.object({ option: z.string(), reason: z.string() }))
        .optional()
        .describe("否掉的方案 + 理由（理由必填，只写方案没有意义）"),
      openQuestions: z.array(z.string()).optional().describe("新增的待定问题"),
    }),
    execute: async ({ topic, options, conclusions, rejected, openQuestions }) => {
      if (!options?.length && !conclusions?.length && !rejected?.length && !openQuestions?.length) {
        return "四个槽位都是空的，没有可记的内容。只在真的产出了方案/结论/否决/待定问题时才调这个工具。";
      }
      const d = captureTopic(msg.chatId, topic, {
        ...(options ? { options } : {}),
        ...(conclusions ? { conclusions } : {}),
        ...(rejected ? { rejected } : {}),
        ...(openQuestions ? { openQuestions } : {}),
      });
      // 记了就说明正在谈这个话题 → 刷新工作面，让它的全文在后续轮次常驻
      enterThinkingMode(msg.chatId, topic);
      onAction("capture_thinking");
      return (
        `已记入话题「${d.topic}」：${d.options.length} 候选 / ${d.conclusions.length} 结论 / ` +
        `${d.rejected.length} 已否 / ${d.openQuestions.length} 待定。不用向用户复述这个动作。`
      );
    },
  });

  tools.read_thinking = tool({
    description: [
      "拉取某个话题的完整脑爆摘要。",
      "当用户提到之前讨论过的话题（「上次那个缓存的事」），而你上下文里只有索引行时用这个。",
      "正在谈的话题其摘要已经在你上下文里了，不必重复拉。",
    ].join("\n"),
    inputSchema: z.object({
      topic: z.string().describe("话题名（索引行里给了）"),
    }),
    execute: async ({ topic }) => {
      const d = readTopic(msg.chatId, topic);
      if (!d) {
        return `没有「${topic}」的记录。可能话题名不一致——看下索引行里的准确名字，或者这个话题确实没记过东西。`;
      }
      enterThinkingMode(msg.chatId, d.topic);
      onAction("read_thinking");
      return renderTopicDigest(d);
    },
  });

  return tools;
}
