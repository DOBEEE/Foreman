import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentOptions } from "../types/agent-options.js";
import type { ToolGuard } from "../runtime/hooks.js";
import { config } from "../config/index.js";
import { resolveProvider } from "../config/provider-env.js";
import {
  loadAgentProfile,
  profileRetroSpec,
  resolveReadRoots,
  resolveWorkspace,
  type AgentProfile,
  type WorkspacePolicy,
} from "../config/agent-profile.js";
import { loadMcpServers, pickOptionalServers } from "../core/mcp.js";
import {
  buildAuditGuard,
  buildBranchGuard,
  buildMemoryOffGuard,
  buildMemoryScopeGuard,
  buildMcpScopeGuard,
  buildNotesScopeGuard,
  buildReadRootsGuard,
} from "../core/audit.js";
import { ensureNotesDir, noteFileOf, notesDirOf, NOTES_TTL_DAYS } from "../core/notes.js";
import { renderWorkbenchIndex } from "../core/workbench.js";
import { renderRecentArchive } from "../core/task-archive.js";
import { loadMemory } from "../core/memory.js";
import { buildKnowledgeIndex, formatCodeRoots } from "../core/knowledge.js";
import {
  REPORT_DONE_TOOL,
} from "../tools/task-report.js";
import { SCHEDULE_LATER_TOOL } from "../tools/schedule.js";
import { SUBMIT_STEP_TOOL } from "../tools/step-report.js";
import { buildAskRelay } from "../tools/ask-relay.js";
import { ASK_USER_TOOL } from "../tools/ask-user.js";
import {
  buildAskUserTool,
  buildReportDoneTool,
  buildScheduleLaterTool,
} from "../runtime/tools/protocol-tools.js";
import { buildDelegateTaskTool } from "../runtime/tools/delegate-task.js";
import {
  buildGetTaskRecordTool,
  buildSearchTaskHistoryTool,
} from "../runtime/tools/task-history.js";
import { buildSkillTool } from "../runtime/tools/skill-tool.js";
import {
  formatSkillCatalog,
  formatSkillsForSystemPrompt,
  loadSkills,
} from "../runtime/skills.js";
import {
  appendRunLog,
  appendTraceLog,
  truncate,
  type AgentKind,
  type TraceEvent,
} from "../core/logger.js";
import {
  collectRun,
  executeQuery,
  type AgentEvent,
  type RunInput,
  type RunSummary,
} from "../core/runner.js";

/** afterRun 收到的本轮执行结果 */
export interface RunOutcome {
  /** 正常结束的汇总；流被中断/异常时可能为 undefined */
  summary?: RunSummary;
  /** 执行过程中抛出的错误（正常结束为 undefined） */
  error?: unknown;
}

/** 模板渲染：{{key}} 占位替换，缺失的 key 渲染为空串 */
export function renderTemplate(
  template: string,
  params: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_raw, key) =>
    params[key] == null ? "" : String(params[key]),
  );
}

/**
 * 员工协作协议：boss 派发的任务（params.taskId 存在）统一注入。
 * 规范三件事：怎么向老板/用户提问、怎么宣告任务结束、完成时输出什么。
 * boss 侧依赖这些约定做状态判定与验收（见 boss.ts runWorker / review）。
 */
function buildEmployeeProtocol(
  noteFile: string,
  workbenchIndex?: string,
  siblings?: string,
  crossChatHistory?: string,
): string {
  const workbenchSection = workbenchIndex
    ? `
### 你在这个会话里做过什么（工作台索引，系统自动记录）
${workbenchIndex}

**开场先扫一眼这份索引**——当前这件活很可能是其中某件的延续，而你的上下文是按任务隔离的
（每件活一个独立会话），不看索引你就会把做过的事重做一遍、或者推翻自己之前的结论。
要当时的细节（报错原文、废弃方案）时按上面的笔记路径 Read；索引里没有的，向主管报任务号索取。

⚠️ **索引里的结论是"当时"的结论，不是现状**：代码、环境、需求都可能已经变了。
凡是当前任务要依赖的关键前提，重新确认一遍再用。
`
    : "";
  const siblingSection = siblings
    ? `
### 你手上同时在办的其它任务
${siblings}

这些活各自跑在**独立会话**里，你**看不到**它们的上下文，它们也看不到你这边的。
用户这次说的事看起来像是那几件里某一件的延续时，**不要凭猜接着做**——
用 ${ASK_USER_TOOL} 请他确认是哪一件（报任务号），主管会把你接回那条会话。
`
    : "";
  const historySection = crossChatHistory
    ? `
### 你在**其它会话**里最近做过什么（任务档案摘要）
${crossChatHistory}

上面的工作台索引只覆盖**当前**这个会话；换了群、换了渠道它就看不到了，所以这一节补的是别处的活。
更早的历史用 \`search_task_history\`（按关键词 / 日期 / 终态查，只查得到你自己的），
要某条的完整档案用 \`get_task_record\` 按任务号取。**不要**自己去猜归档文件路径读——
会话 id 到文件名的转义是有损的，拼错的结果是"查不到"，你会误以为没这回事。
`
    : `
### 查你自己的历史任务
用 \`search_task_history\`（按关键词 / 日期 / 终态查，只查得到你自己的），
要某条完整档案用 \`get_task_record\` 按任务号取。**不要**自己猜归档文件路径去读。
`;
  return `
## 协作协议（你是团队一员，本任务由主管派发，完成后由主管验收并转达用户）
${workbenchSection}${siblingSection}${historySection}
本轮结束前，你**必须**调用下面两个工具之一明确表态。只输出文本就结束会被系统拦回来重做。

### 需要用户确认 / 决策 / 补充信息时
- **调用 ${ASK_USER_TOOL} 工具**提问（每个问题给 2~5 个可选项，能并列的问题一次性问完）。
- **禁止**用纯文本抛出问题后就结束——主管只认工具信号。
- 调用后本轮自然结束即可，用户的回答会在下一轮带回给你。
- 这个渠道没有交互终端，内置的 AskUserQuestion 不可用（已从你的工具集里移除），提问只有这一条路。
- **任务分阶段时（brief 写着「先 X，用户确认后再 Y」）：X 做完不是收尾，走这里，不要交卷。**
  把成果直接贴在提问里让用户点头，然后你会在**同一会话**里接着做 Y——查过的东西、拿到的数据都还在。
  交卷意味着这条会话到此结束：后续阶段会变成一个新任务、可能换个人从零开始，把你刚查的一遍全部重查。

### 任务真正收尾时（做完了，或确认无法完成）
- **调用 ${REPORT_DONE_TOOL} 工具**交卷。这个工具的参数就是主管和用户能看到的最终回复，必须一次写完整；调用后不要再输出任何文本。
- 内容要结论先行、信息完整且简练，避免在多个字段重复同一件事。按字段填写：
  - outcome：done（做完了）/ cannot_complete（确认无法完成）
  - conclusion：直接说清是否完成、核心结果和必要判断；完整但不要铺陈过程
  - deliverables：只列关键产出（文件、路径、分支、命令或数据），没有填「无」
  - verification：简要列出实际验证及结果，没验证的如实说明
  - risks：只列真实风险与遗留，没有填「无」
- **只在真正收尾时调用**。只要还需要用户给任何输入，就用 ${ASK_USER_TOOL} 提问，不要交卷。
- cannot_complete 用于「卡住且不是靠用户回答能解决」的情况；如果是缺信息，那是提问不是交卷。

### 你的随手笔记（写这里，不要写 memory）
你的笔记文件：\`${noteFile}\`（用 Write/Edit **追加**，不要重写覆盖）。
**只写这一个路径**，不要自己按日期或任务号另拼一个——这个路径可能是本任务专属的，
拼错会写到别人那份上，把对方的笔记整体覆盖掉。
这个目录**已对你放行**（即使你的岗位有只读范围限制也一样）——写不进去是别的原因，不要当成「没权限」放弃。

**笔记主要是写给复盘员看的，不是写给自己看的** —— **本任务内**的上下文你已经有了，不用每轮开头去读它。
跨任务要回顾"这个会话里做过什么"，看的是上面的工作台索引，不是翻笔记。
只有两种情况值得 Read 一下：① 这个坑似曾相识、怀疑今天早些时候已经踩过（复盘每天才跑一次，
当天的经验还没进经验库）；② 会话很长、早期细节已被压缩掉，要找回当时的报错原文或废弃方案。

**只记执行日志里推不出来的东西**（工具调用和结果系统已经全程记录了，别重复抄）：
- **决策与理由**：在几种做法里选了哪个、为什么，尤其「看着该选 B 但实际不行」
- **坑与绕法**：报错关键行 + 根因 + 最终怎么绕过的，带上定位信息（file:line / 命令 / 任务号）
- **环境事实**：哪个端点不可达、哪个工具在本环境无效、哪个目录不可写、某仓库的构建命令
- **废弃路径**：试过但不行的方案 + 为什么不行（日志里只有一堆失败调用，看不出你的结论）

**什么时候记**：踩坑当场（趁热，别等收尾忘了细节）、换方向前（记下为什么放弃）、交卷前（补 1-3 条最值得留的）。

**每条必须带一句「可复用：…」**——写不出可复用价值的就别记。**没有新知就不记，「今天无可记」是合法的**，凑数会污染复盘输入。

格式（一坑一段，追加即可）：
\`\`\`md
## <任务号>
- 坑：<报错/现象关键行>
- 根因：<为什么>
- 绕法：<最终怎么做的>
- 可复用：<下次遇到什么情况该怎么做>
\`\`\`

### 经验沉淀（别自己动手）
- 团队经验库（memory/）由**复盘员**每日从你的笔记 + 执行日志里蒸馏，你**不要**自己写任何 memory 目录：
  服务端已关闭 SDK 自带记忆，写别处也会被门禁拦下——那不是权限配错，是设计如此。
- 笔记只能写自己的目录，写别人的笔记同样会被拦。
- 笔记是**可丢弃原料**（${NOTES_TTL_DAYS} 天后自动清理），值得长期留下的会由复盘员晋升进经验库。

**不要**在做完一半时默默停下：要么继续做完，要么提问，要么交卷说明无法完成。
`.trim();
}

/** 编队内部委派的上下文（executor 通过 params.__squad 传入） */
export interface SquadBrief {
  /** 组长展示名/id */
  lead?: string;
  /** 任务整体目标 */
  goal?: string;
  /** 本步 id / 标题 */
  stepId?: string;
  stepTitle?: string;
  /** 本步验收标准（有则要求执行者返回前自检） */
  accept?: string;
  /** 你在编队中的角色：worker=执行者 / reviewer=评审人 */
  role?: "worker" | "reviewer";
}

/**
 * 编队协作协议：编队内部委派（params.__internal=true）注入，替代 EMPLOYEE_PROTOCOL。
 * 关键差异：对接人是组长不是老板/用户——产出直接返回文本，不交卷、不问用户。
 */
function buildSquadProtocol(squad: SquadBrief | undefined): string {
  const lead = squad?.lead ?? "组长";
  const lines = [
    `## 编队协作协议（本次是编队内部委派，你的对接人是组长「${lead}」，不是老板或最终用户）`,
    "",
    squad?.goal ? `- 任务整体目标：${squad.goal}` : "",
    squad?.stepTitle
      ? `- 你负责的步骤：${squad.stepId ? `[${squad.stepId}] ` : ""}${squad.stepTitle}`
      : "",
    squad?.role === "reviewer"
      ? "- 你的角色是**评审人**：只评审不修改，按要求输出结论。"
      : squad?.accept
        ? `- 本步验收标准：${squad.accept}\n- **返回前对照验收标准自检一遍**，不达标先自己修，别等打回。`
        : "",
    "",
    "### 规则",
    `- **本步做完必须调 \`${SUBMIT_STEP_TOOL}\` 向组长交卷**：工具参数是组长和下游步骤唯一能看到的产出。` +
      "只输出文本就结束**不算交卷**，会被系统拦回来重做一次——那一轮等于白跑。",
    squad?.role === "reviewer"
      ? "- 交卷时 `verdict` 必填（pass / reject）：引擎只认这个字段，不通过就写清具体、可执行的修改意见。"
      : "- 交卷不会结束整个任务，只是把本步成果交给组长；对老板的交卷/提问通道在这里不存在（工具已移除）。",
    "- **你和最终用户之间没有通道**，AskUserQuestion 这类提问工具在这里拿不到回答。需要别人拍板的事一律调 `escalate` 问组长：",
    "  - 拿不到答复就没法正确往下做（改哪个包、两个方案取舍、要不要动别的模块）→ `blocking: true`，组长的当场答复会作为工具返回值给你；",
    "  - 只是需要知会一声、或有更优做法待定 → `blocking: false`，登记后你按最佳判断继续，并在产出里写明采用的假设。",
    "  只写在正文里**不算提问**：组长收尾时只认 escalate 登记过的条目。",
    "- 只做本步职责内的事，不越权替其他步骤做决定。",
    "- **不要自己写任何 memory 目录**：经验由复盘员统一蒸馏；本步的教训写进交卷的 `decisions` 字段，组长会带回。",
  ].filter(Boolean);
  return lines.join("\n");
}

/** 工作目录策略见 config/agent-profile.ts */
export type { WorkspacePolicy };

function safeBucket(chatId: unknown): string {
  const raw = typeof chatId === "string" && chatId ? chatId : "local";
  return raw.replace(/[^\w-]/g, "_");
}

/**
 * Agent 基类：**只承载运行机制与代码行为**。
 * 所有声明式设置（职责、提示词、模型、轮次、工具白名单、工作目录、复盘规则…）
 * 一律来自 AgentProfile：
 * - 内置岗位 → server/config/agents/<name>.json，子类只写代码行为（hook / 动态提示词 / 覆写 run）
 * - 配置员工 → <runtimeDir>/agents/<id>.json，构造期用 useProfile 注入
 */
/** 会改动工作目录内容的工具：决定同目录能否并行 */
const MUTATING_TOOLS = new Set(["Write", "Edit", "Bash", "Task", "NotebookEdit"]);

export abstract class BaseAgent {
  /** 路由名 = 配置文件名，全局唯一，如 "code-review" */
  abstract readonly name: string;

  /**
   * 本岗位的声明式配置：按 name 读 server/config/agents/<name>.json（内置）
   * 或 <runtimeDir>/agents/<name>.json（招聘）。mtime 缓存，改 JSON 即时生效、无需重启。
   */
  get profile(): AgentProfile {
    return loadAgentProfile(this.name) ?? { id: this.name };
  }

  /** 拟人化展示名（如 coder →「小码」）：boss 播报与点名路由用 */
  get displayName(): string | undefined {
    return this.profile.displayName;
  }
  /** 一句话职责，用于 GET /api/agents 展示 */
  get description(): string {
    return this.profile.description ?? this.name;
  }
  /** 路由职责卡（【选我当】/【别选我当】），缺省用 description */
  get routeHint(): string | undefined {
    return this.profile.routeHint;
  }
  /** 本 agent 需要的业务入参说明（key → 含义），路由器据此从用户输入中提取 */
  get paramsSchema(): Record<string, string> | undefined {
    return this.profile.paramsSchema;
  }
  /** 路由兜底岗位（LLM 分类失败/无候选时选它），全局限一个 */
  get routeFallback(): boolean {
    return this.profile.routeFallback ?? false;
  }
  /** 仅手动触发，不参与自动路由（复盘 / 提示词优化） */
  get manualOnly(): boolean {
    return this.profile.manualOnly ?? false;
  }
  /** 记录归属：写进 run/trace 日志，让临时工的记录能干净地与正式成员分开 */
  agentKind(): AgentKind {
    if (this.profile.temp) return "temp";
    return this.profile.source === "hired" ? "employee" : "builtin";
  }
  /** 默认响应模式：true=SSE 流式，false=一次性 JSON。请求体 stream 字段可临时覆盖 */
  get stream(): boolean {
    return this.profile.stream ?? true;
  }
  /** 复盘沉淀规则：未声明 retro.enabled 的岗位不参与复盘 */
  get retroSpec():
    | { enabled: boolean; distill: string[]; exclude?: string[] }
    | undefined {
    return profileRetroSpec(this.profile);
  }

  /** 规则快速通道：正则命中直接路由到本 agent（命名捕获组自动成为 params） */
  readonly routePatterns?: RegExp[];

  /** 子类专属门禁（如 tooler 只许写 runtimeDir、optimizer 只许写提案目录） */
  protected readonly sdkGuards?: ToolGuard[];
  /**
   * 经验库写入放行的员工名：默认 undefined = 全体只读（常规运行）。
   * 复盘员工按当前复盘对象覆写此值以放行写入其子目录。
   */
  protected memoryWriteScope?: string;

  private promptTemplateCache?: string;

  /** 加载提示词模板：systemPromptFile（prompts/ 下的 md）优先，带磁盘缓存 */
  protected loadPromptTemplate(): string | undefined {
    const { systemPromptFile, systemPrompt } = this.profile;
    if (systemPromptFile) {
      this.promptTemplateCache ??= readFileSync(
        new URL(`./prompts/${systemPromptFile}`, import.meta.url),
        "utf-8",
      );
      return this.promptTemplateCache;
    }
    return systemPrompt;
  }

  /** 本 agent 的工作目录基址：声明了 workspace 用它，否则回落全局 workingDir */
  protected resolveCwd(): string {
    return this.profile.workspace
      ? resolveWorkspace(this.profile)
      : config.workingDir;
  }

  /** 本 agent 生效的工作目录策略 */
  protected workspaceModeFor(): WorkspacePolicy {
    return this.profile.workspacePolicy ?? "shared";
  }

  /** 多次 run 是否共享同一个工作目录（只有 shared / per-chat 共享；per-task / per-run 各自独立） */
  protected sharesWorkspace(): boolean {
    const mode = this.workspaceModeFor();
    return mode === "shared" || mode === "per-chat";
  }

  /**
   * 本岗位是否必须串行执行（不能同时跑两个 run）。
   * 判据：共享工作目录 **且** 具备写/执行能力——两个 run 同时改同一个 clone 会踩踏
   * （如 coder 一边切分支一边改文件）。只读岗位共享目录无害，可放心并行。
   * 定时任务据此决定「直接并行」还是「排队等目录空出」。
   */
  needsSerialRun(): boolean {
    if (!this.sharesWorkspace()) return false;
    const tools = this.profile.tools;
    // 无白名单 = 全工具放行 → 保守视为有写能力
    if (!tools?.length) return true;
    return tools.some((t) => MUTATING_TOOLS.has(t));
  }

  /**
   * 本次 run 生效的工作目录：显式 cwd（如 per-run 隔离目录）优先，其次按策略分桶。
   *
   * public 是因为 boss 的产出合约硬校验要按这个目录解析员工声明的相对产出路径——
   * 没有它就只能去猜工作目录在哪，而 per-chat / per-task / per-run 策略下猜不对。
   */
  resolveRunCwd(input: RunInput): string {
    if (input.cwd) return input.cwd;
    const mode = this.workspaceModeFor();
    if (mode === "per-chat" || mode === "per-task") {
      const chatDir = join(this.resolveCwd(), safeBucket(input.params?.chatId));
      const taskId = input.params?.taskId;
      // per-task 但拿不到任务号（HTTP /run、bench 这类无任务概念的入口）→ 退化成 per-chat。
      // **绝不能在这里编一个随机 id**：那等于悄悄变成 per-run 语义，同一任务的第二轮
      // （用户回答后续跑）会落到另一个空目录，clone 和分支全丢。
      if (mode === "per-task" && typeof taskId === "string" && taskId) {
        return join(chatDir, `task-${safeBucket(taskId)}`);
      }
      return chatDir;
    }
    return this.resolveCwd();
  }

  /** 模板可用的内置参数（cwd / workspace = 本次 run 工作目录）+ 请求入参，子类可覆写追加 */
  protected buildTemplateParams(input: RunInput): Record<string, unknown> {
    const cwd = this.resolveRunCwd(input);
    return {
      cwd,
      workspace: cwd,
      knowledgeRoot: config.knowledgeDir,
      codeRoots: formatCodeRoots(),
      ...input.params,
    };
  }

  /**
   * 组装系统提示词：默认渲染模板（{{key}} ← 请求 params / 内置 cwd / 知识源占位）。
   * {{knowledgeIndex}} 需要扫描知识库目录，仅在模板真正引用时计算。
   */
  protected buildSystemPrompt(input: RunInput): string | undefined {
    const template = this.loadPromptTemplate();
    if (!template) return undefined;
    const params = this.buildTemplateParams(input);
    if (template.includes("{{knowledgeIndex}}") && params.knowledgeIndex == null) {
      params.knowledgeIndex = buildKnowledgeIndex();
    }
    return renderTemplate(template, params);
  }

  /**
   * 本任务该写哪个笔记文件（顺手建好目录，省得员工首次写笔记时因目录不存在多花一轮）。
   *
   * 并发岗位按任务分文件：同一天两个 run 同时「Read 全文 → Write 追加后的全文」时，
   * 后写的会整体覆盖前一个，静默丢掉一整份笔记。串行岗位路径保持不变（零迁移）。
   *
   * 公开是给 boss 用的：落工作台记录时要一并记下「当时那份笔记在哪」，而这条推导规则
   * 只该有一处实现——boss 那边照抄一份的话，哪天规则改了就会指向一个不存在的路径，
   * 而且不报错。
   */
  noteFilePathFor(taskId?: string): string {
    const date = new Date().toISOString().slice(0, 10);
    try {
      ensureNotesDir(this.name);
    } catch {
      // 建目录失败不阻塞任务，员工写入时会自行处理
    }
    const parallel = (this.profile.maxParallel ?? 1) > 1;
    return parallel && taskId ? noteFileOf(this.name, date, taskId) : noteFileOf(this.name, date);
  }

  protected todayNoteFile(input?: RunInput): string {
    const taskId = input?.params?.taskId;
    return this.noteFilePathFor(typeof taskId === "string" && taskId ? taskId : undefined);
  }

  /**
   * 自动压缩设置：只对大窗口模型（≥ config.compact.minWindow）把阈值主动压到 atPercent。
   * 小窗口返回 undefined —— 不干预，保留 SDK 默认的「快满才压」安全网。
   * autoCompactWindow 合法区间 [100k, 1M]，越界会被 SDK 静默丢弃，所以这里 clamp。
   */
  protected compactSettings(): { autoCompactEnabled: true; autoCompactWindow: number } | undefined {
    const { contextWindow, atPercent, minWindow } = config.compact;
    const window = this.profile.contextWindow ?? contextWindow;
    if (window < minWindow) return undefined;
    const target = Math.round(window * atPercent);
    const clamped = Math.min(1_000_000, Math.max(100_000, target));
    if (clamped !== target) {
      console.warn(
        `[compact] ${this.name}: 目标压缩窗口 ${target} 超出 SDK 允许区间 [100000, 1000000]，已收敛为 ${clamped}`,
      );
    }
    return { autoCompactEnabled: true, autoCompactWindow: clamped };
  }

  /** 组装 SDK Options，子类可覆写以定制更复杂的逻辑 */
  buildOptions(input: RunInput): AgentOptions & { protocolTools?: Record<string, unknown> } {
    const profile = this.profile;
    const basePrompt = this.buildSystemPrompt(input);
    // 回注长期经验（复盘晋升的产物）；仅对参与复盘的岗位注入。
    // input.memory==='off' 时跳过：评测要求同一 prompt 多次运行可比，
    // 而复盘每天都在改写经验库。
    const memory =
      this.retroSpec?.enabled && input.memory !== "off" ? loadMemory(this.name) : undefined;
    const withMemory = memory
      ? `${basePrompt ?? ""}\n\n## 岗位经验库（历史复盘沉淀，供参考，与当前任务冲突时以任务为准）\n\n${memory}`.trim()
      : basePrompt;
    /**
     * Skills（三级渐进披露，对齐 Claude Code）：
     * - L0 预载：profile.skills 显式声明的，正文直接进 system。这是**岗位契约**
     *   （如 HR 必须按招聘手册走），不能指望模型自己想起来去拉。
     * - L1 清单：其余 skill 只给 name + description（约 80 token/skill），
     *   模型判断相关时用 `Skill` 工具取正文（L2）。
     *
     * ⚠️ 必须走 systemPrompt + protocolTools 这条路。`AgentOptions.skills` 是**死路**：
     * runner.executeQuery 从来不透传它，runtime 也不读——这就是 profile.skills
     * 长期静默失效的原因（hr 的 hire-employee、coder 的 clarify-before-action 都没进过上下文）。
     *
     * 排在 memory 之后、协议之前：协议里含编队 stepId 这类每步都变的内容，
     * skill 只随 skill 文件变，更稳定的放前面（对 prompt cache 前缀更友好）。
     */
    const preloadRefs = profile.skills ?? [];
    const preloaded = preloadRefs.length > 0 ? loadSkills(preloadRefs) : [];
    const skillBlocks = [
      preloaded.length > 0 ? formatSkillsForSystemPrompt(preloaded) : "",
      formatSkillCatalog(preloaded.map((s) => s.source)),
    ].filter(Boolean);
    const withSkills =
      skillBlocks.length > 0
        ? `${withMemory ?? ""}\n\n${skillBlocks.join("\n")}`.trim()
        : withMemory;
    // 协议分流（互斥，不叠加）：
    // - 编队内部委派（__internal）→ 编队协议：产出交组长、不交卷、不问用户
    //   （taskId 仍透传用于 trace/dashboard 关联，但不触发对老板的交卷契约）
    // - boss 直派（带 taskId）→ 员工协议：AskUserQuestion 或 report_task_done 二选一
    const isInternal = input.params?.__internal === true;
    const isBossTask = typeof input.params?.taskId === "string" && !isInternal;
    /**
     * 工作台索引：`agent × chat` 维度的历史任务摘要，补上"会话按任务隔离后员工不知道
     * 自己做过什么"这个缺口。
     *
     * 只对 boss 直派任务注入——编队内部委派由组长给上下文，不该混进员工自己的历史。
     * `memory === "off"` 时跳过，与经验库同理：评测要求同一 prompt 多次运行可比，
     * 而工作台每收尾一个任务就变。
     *
     * 位置在协议里（整个系统提示的尾部）是有意的：这段每个任务都不一样，是最易变的内容，
     * 放尾部才不会把前面稳定的人格 / 经验库 / skill 那段 prompt cache 前缀顶掉。
     */
    const chatId = input.params?.chatId;
    const workbenchIndex =
      isBossTask && input.memory !== "off" && typeof chatId === "string" && chatId
        ? renderWorkbenchIndex(this.name, chatId)
        : undefined;
    // 在办同侪由 boss 通过 params 注入：占用态是 boss 的账本，而 agents 层不能反向 import boss
    const siblings =
      typeof input.params?.__siblings === "string" ? input.params.__siblings : undefined;
    // 跨会话档案摘要：工作台按 chat 分文件，换个群它就一无所知，这里补最近几条别处的活
    const crossChatHistory =
      isBossTask && input.memory !== "off"
        ? renderRecentArchive(this.name, typeof chatId === "string" && chatId ? { excludeChatId: chatId } : {})
        : undefined;
    const systemPrompt = isBossTask
      ? `${withSkills ?? ""}\n\n${buildEmployeeProtocol(this.todayNoteFile(input), workbenchIndex, siblings, crossChatHistory)}`.trim()
      : isInternal
        ? `${withSkills ?? ""}\n\n${buildSquadProtocol(input.params?.__squad as SquadBrief | undefined)}`.trim()
        : withSkills;
    const identity = {
      channel:
        typeof input.params?.channel === "string" ? input.params.channel : undefined,
      senderId:
        typeof input.params?.senderId === "string" ? input.params.senderId : undefined,
      senderName:
        typeof input.params?.senderName === "string"
          ? input.params.senderName
          : undefined,
    };
    // 文件访问门禁：profile.readRoots 声明即启用（如答疑岗只许碰知识库/代码仓库）。
    // 读写分离：声明的检索源严格只读；可写范围只有「自己的工作目录 + 自己的笔记目录」——
    // 协议要求人人写笔记，若不放行笔记目录就会出现「协议让写、门禁又拦」的死结；
    // 而把检索源留成只读，是为了防只读岗位覆写知识库这类事实源。
    const runCwd = this.resolveRunCwd(input);
    const declaredReadRoots = resolveReadRoots(profile);
    const guardRoots = declaredReadRoots
      ? {
          read: [runCwd, ...declaredReadRoots, notesDirOf(this.name)],
          write: [runCwd, notesDirOf(this.name)],
        }
      : undefined;
    const guards: ToolGuard[] = [
      // 审计（全员、只记不拦）放最前：被后续 guard 拦下的调用也要留痕
      buildAuditGuard(this.name, identity),
      // 内置门禁（全员生效）：禁止 push 主干分支（master/main），合入走 MR/PR
      buildBranchGuard(this.name),
      // 笔记写入范围：只许写自己的 notes/<id>/
      buildNotesScopeGuard(this.name),
      // 文件访问门禁：如答疑岗只许读知识库/代码仓库，只许写工作目录与自己的笔记
      guardRoots
        ? buildReadRootsGuard(this.name, runCwd, guardRoots.read, guardRoots.write)
        : undefined,
      // MCP 工具范围：tools 白名单里的 mcp__ 条目即授权范围（第二道；注册期已过滤）
      profile.tools?.length
        ? buildMcpScopeGuard(this.name, profile.tools.filter((t) => t.startsWith("mcp__")))
        : undefined,
      // 记忆策略：MEMORY=off（serve 默认）时拦截 SDK 自带记忆的读写
      config.memoryEnabled ? undefined : buildMemoryOffGuard(this.name),
      // 经验库写入范围：常规运行只读（复盘员工覆写 memoryWriteScope 放行自身目录）
      buildMemoryScopeGuard(this.name, this.memoryWriteScope),
      ...(this.sdkGuards ?? []),
    ].filter((g): g is ToolGuard => Boolean(g));
    // ─── 协议工具实例（Vercel AI inline tools）───────────────────
    // boss 派发的任务：给员工 ask_user + report_task_done（handlers 为 no-op：
    // 副作用由 boss 层监听 tool_call 事件实现，工具只需存在让模型能调用）
    const protocolTools: Record<string, unknown> = {};
    // Skill 工具（渐进披露 L2）：全场景放行。system prompt 里给了技能清单，
    // 就必须给对应的取用工具，否则清单是空头承诺。
    protocolTools.Skill = buildSkillTool();
    if (isBossTask) {
      protocolTools.ask_user = buildAskUserTool(() => {});
      protocolTools.report_task_done = buildReportDoneTool(() => {});
      /**
       * 任务档案查询：开场只注入最近几条（工作台索引 + 跨会话摘要），更早的靠这两个工具查。
       * 作用域锁成自己（scopeAgent = this.name）——入参里没有 agentName，模型越不过去。
       */
      protocolTools.search_task_history = buildSearchTaskHistoryTool(this.name);
      protocolTools.get_task_record = buildGetTaskRecordTool(this.name);
    }
    const isScheduledRun = input.params?.scheduled === true;
    const wantsSchedule =
      isBossTask &&
      !isScheduledRun &&
      (profile.tools?.includes(SCHEDULE_LATER_TOOL) ?? false);
    if (wantsSchedule) {
      protocolTools.schedule_later = buildScheduleLaterTool(async (s) => {
        return `已安排：${s.title}，${s.delayMinutes} 分钟后执行`;
      });
    }
    // Task 工具（sub-agent 委派）：把子任务交给独立上下文的 agent 完成
    const depth = Number(input.params?.__depth ?? 0);
    if (depth < 2) {
      protocolTools.Task = buildDelegateTaskTool(async ({ agent: agentName, task, context }) => {
        const { getAgent: getAgentFn } = await import("./registry.js");
        const subAgent = getAgentFn(agentName);
        if (!subAgent) return `Error: unknown agent "${agentName}"`;
        const subPrompt = context ? `${task}\n\nContext:\n${context}` : task;
        const { text } = await collectRun(
          subAgent.run({
            prompt: subPrompt,
            cwd: runCwd,
            params: {
              ...input.params,
              __internal: true,
              __depth: depth + 1,
              delegatedBy: this.name,
            },
            abortController: input.abortController,
          }),
        );
        return text || "(sub-agent returned no text)";
      });
    }
    // 编队委派注入的额外工具（如 reject_upstream）：executor 通过 params.__extraTools 传入
    const extraTools = input.params?.__extraTools as Record<string, unknown> | undefined;
    if (extraTools) Object.assign(protocolTools, extraTools);
    // 有工具白名单的 agent 需显式放行交卷/提问工具，否则模型看不到、协议无法执行
    const allowedTools = profile.tools?.length
      ? [
          ...new Set(
            isBossTask
              ? [...profile.tools, REPORT_DONE_TOOL, ASK_USER_TOOL]
              : profile.tools,
          ),
        ].filter((t) => !config.disabledTools.includes(t))
      : undefined;
    /**
     * 内置工具真限制：`tools` 才是 SDK 的「可用工具集」（allowedTools 只是免审批清单，
     * 在 bypassPermissions 下等于没限制）。只取白名单里的非 MCP 条目——MCP 那部分
     * 由 buildMcpScopeHooks 兜（SDK 的 tools 选项管不到 MCP 工具）。
     *
     * boss 任务额外并入协议必需的内置工具：不给这几个，协议就是空头承诺——
     * Write/Edit 用来记笔记（能写到哪由门禁的可写根决定，只读岗位仍然只能写自己的
     * 工作目录与笔记目录）。
     * 提问不在此列：内置 AskUserQuestion 在服务端拿不到回答，已换成自建的 ask_user。
     * Skill 也不在此列：它是**协议工具**（protocolTools.Skill），全场景放行且不经
     * 内置白名单过滤——写在这里 filterBuiltins 只会去内置工具袋里找一个叫 Skill 的
     * 内置工具，根本找不到。
     */
    const PROTOCOL_BUILTINS = ["Write", "Edit", "Read"];
    const tools = profile.tools?.length
      ? [
          ...new Set([
            ...profile.tools.filter((t) => !t.startsWith("mcp__")),
            ...(isBossTask ? PROTOCOL_BUILTINS : []),
          ]),
        ].filter((t) => !config.disabledTools.includes(t))
      : undefined;
    // 按员工独立的模型供应商与凭据（provider.id 引用 providers.json；未设走全局默认→.env 兜底）
    const prov = resolveProvider(profile.provider);
    return {
      cwd: runCwd,
      model:
        profile.provider?.model ??
        profile.model ??
        prov.providerDefaultModel ??
        config.model,
      /**
       * Qoder runtime 的模型档位，与上面的 `model` 各走一套（标识体系不通用）。
       * 只有 QoderRuntime 会读它；vercel 下这个字段一路被忽略。
       */
      qoderModel: profile.qoderModel ?? config.qoder.model,
      maxTurns: input.maxTurns ?? profile.maxTurns ?? config.maxTurns,
      ...(profile.maxThinkingTokens
        ? { maxThinkingTokens: profile.maxThinkingTokens }
        : {}),
      // Prompt cache 档位：不设 = short(5m)。long(1h) 只给一小时内确实会被 resume 的常驻岗位
      ...(profile.cacheRetention ? { cacheRetention: profile.cacheRetention } : {}),
      includePartialMessages: true,
      // 服务端无人工审批，直接放行全部工具
      permissionMode: "bypassPermissions",
      // 提问转交：boss 派发的任务里，AskUserQuestion 必须挡住员工等主管上报，
      // 不能让 SDK 的「无人应答→判失败」把员工推去自己猜答案（只有提问会走这个回调）
      ...(isBossTask ? { canUseTool: buildAskRelay() } : {}),
      // 自包含：MCP 只来自 server/config/mcp.servers.json，不继承运行机器的用户级 ~/.claude 配置。
      // （否则会多出用户级 MCP 并发启动，加剧冷启动竞争，导致部分 MCP 就绪超时被丢弃）
      settingSources: [],
      ...(allowedTools ? { allowedTools } : {}),
      // 内置工具真限制：白名单岗位只拿到声明的内置工具
      ...(tools ? { tools } : {}),
      /**
       * MCP 授权范围（tools 白名单里的 mcp__ 条目）。runtime 据此在**注册期**就把
       * 未授权的 MCP 工具剔出工具袋——模型看不见=不会调=不烧 token；
       * buildMcpScopeGuard 是同一套规则的第二道，防注册侧漏。
       */
      ...(profile.tools?.length
        ? { mcpAllow: profile.tools.filter((t) => t.startsWith("mcp__")) }
        : {}),
      // 上下文自动压缩：大窗口模型按 config.compact.atPercent 提前压，小窗口不传（走 SDK 默认）
      ...(() => {
        const compact = this.compactSettings();
        return compact ? { settings: compact } : {};
      })(),
      // 本环境跑不通的内置工具硬禁（网关不支持 web_search / WebFetch 域名校验被网络策略拦）；
      // boss 任务再加上内置 AskUserQuestion —— 它在服务端永远拿不到回答，留在上下文里只会
      // 让员工调一次、吃一个工具错误、然后自己猜答案接着做（提问改走自建的 ask_user）
      ...(() => {
        const denied = [...config.disabledTools, ...(isBossTask ? ["AskUserQuestion"] : [])];
        return denied.length > 0 ? { disallowedTools: denied } : {};
      })(),
      ...(guards.length > 0 ? { guards } : {}),
      // 全局 MCP + 本岗位点名的按需 MCP（server/config/mcp.servers.json 的 optionalServers）
      mcpServers: {
        ...loadMcpServers(),
        ...pickOptionalServers(profile.mcpServers),
      },
      protocolTools,
      abortController: input.abortController,
      env: prov.env as Record<string, string>,
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.persistSession ? { persistSession: true } : {}),
      ...(systemPrompt
        ? {
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: systemPrompt,
            },
          }
        : {}),
    };
  }

  /**
   * 执行前钩子：参数校验、工作目录准备、记录开始日志等。
   * 抛错会中止本次运行（afterRun 仍会执行，error 原样带出）。
   */
  protected async beforeRun(_input: RunInput): Promise<void> {}

  /** 执行后钩子：结果落库、上报、清理临时文件等。无论成败都会执行 */
  protected async afterRun(
    _input: RunInput,
    _outcome: RunOutcome,
  ): Promise<void> {}

  /** 确保工作目录存在，不存在则递归创建（在 beforeRun 之前执行） */
  protected ensureCwd(input?: RunInput): void {
    mkdirSync(input ? this.resolveRunCwd(input) : this.resolveCwd(), {
      recursive: true,
    });
  }

  async *run(input: RunInput): AsyncGenerator<AgentEvent> {
    yield* this.runInstrumented(input);
  }

  /**
   * 带插桩的一次模型会话：跑 executeQuery，同时落 run 日志 + trace，并跑 before/afterRun。
   *
   * 覆写 `run()` 的岗位（retro 的逐岗位复盘、lead 的每轮组长会话）**必须走这里**，
   * 不要直接调 executeQuery——那条路不落任何日志，这些子运行在 runs/traces 里根本不存在。
   * 真实代价：复盘按纪律要求「笔记里的结论必须能在 trace 里对上才能沉淀」，而 lead 连续多天
   * 零 run 记录，于是它的真实经验被当成「无 trace 佐证」丢弃；优化师归因也看不到这些运行。
   */
  protected async *runInstrumented(input: RunInput): AsyncGenerator<AgentEvent> {
    const startedAt = new Date();
    const startMs = startedAt.getTime();
    const runId = randomUUID();
    // per-run 目录隔离：并发调用互不可见，结束后清理。
    // 调用方显式给了 cwd（外部编排 / 评测）时不隔离——那是别人的目录，
    // 既不该覆盖也不该在 finally 里删掉。
    const perRunIsolated = this.workspaceModeFor() === "per-run" && !input.cwd;
    const runInput: RunInput = perRunIsolated
      ? { ...input, cwd: join(this.resolveCwd(), `run-${runId.slice(0, 8)}`) }
      : input;
    const outcome: RunOutcome = {};
    const textParts: string[] = [];
    const toolCalls: Array<{ name: string; input: unknown }> = [];

    // trace 旁路收集：连续 text 增量合并为一条，事件带 seq/t，超上限丢弃计数
    const MAX_TRACE_EVENTS = 800;
    const traceEvents: TraceEvent[] = [];
    let droppedEvents = 0;
    let seq = 0;
    let textBuf: { seq: number; t: number; parts: string[] } | undefined;
    const pushTrace = (e: TraceEvent): void => {
      if (traceEvents.length >= MAX_TRACE_EVENTS) droppedEvents++;
      else traceEvents.push(e);
    };
    const flushTextBuf = (): void => {
      if (!textBuf) return;
      pushTrace({
        seq: textBuf.seq,
        t: textBuf.t,
        type: "text",
        text: textBuf.parts.join(""),
      });
      textBuf = undefined;
    };

    try {
      this.ensureCwd(runInput);
      await this.beforeRun(runInput);
      for await (const e of executeQuery(
        runInput.prompt,
        this.buildOptions(runInput),
      )) {
        const t = Date.now() - startMs;
        if (e.event === "text") {
          textParts.push(e.data.text);
          textBuf ??= { seq: seq++, t, parts: [] };
          textBuf.parts.push(e.data.text);
        } else {
          flushTextBuf();
          if (e.event === "result") {
            outcome.summary = e.data;
            pushTrace({
              seq: seq++,
              t,
              type: "result",
              subtype: e.data.subtype,
              isError: e.data.isError,
            });
          } else if (e.event === "tool_call") {
            toolCalls.push({ name: e.data.name, input: e.data.input });
            pushTrace({
              seq: seq++,
              t,
              type: "tool_call",
              id: e.data.id,
              name: e.data.name,
              input: truncate(e.data.input, 2000),
            });
          } else if (e.event === "tool_result") {
            pushTrace({
              seq: seq++,
              t,
              type: "tool_result",
              toolUseId: e.data.toolUseId,
              ...(e.data.isError != null ? { isError: e.data.isError } : {}),
              content: truncate(e.data.content, 4000),
            });
          } else if (e.event === "thinking") {
            pushTrace({
              seq: seq++,
              t,
              type: "thinking",
              text: String(truncate(e.data.text, 4000)),
            });
          } else if (e.event === "compact") {
            // 落 trace：复盘/优化员据此判断「这轮是否因为压缩丢过上下文」
            pushTrace({
              seq: seq++,
              t,
              type: "compact",
              trigger: e.data.trigger,
              preTokens: e.data.preTokens,
              ...(e.data.postTokens != null ? { postTokens: e.data.postTokens } : {}),
            });
            console.log(
              `[compact] ${this.name}: ${e.data.trigger} 触发，${e.data.preTokens} → ${e.data.postTokens ?? "?"} tokens`,
            );
          } else if (e.event === "notice") {
            // 环境异常但没中断执行（如 MCP 连接失败）。落 trace：事后归因
            // 「为什么这轮模型没用某个工具 / 为什么这轮缓存全 miss」要靠它
            pushTrace({
              seq: seq++,
              t,
              type: "notice",
              level: e.data.level,
              message: e.data.message,
            });
            console.warn(`[notice] ${this.name}: ${e.data.message}`);
          }
        }
        yield e;
      }
    } catch (error) {
      outcome.error = error;
      throw error;
    } finally {
      flushTextBuf();
      const channel =
        typeof input.params?.channel === "string"
          ? input.params.channel
          : undefined;
      const isError = outcome.summary?.isError ?? Boolean(outcome.error);
      const errorMessage =
        outcome.error instanceof Error
          ? outcome.error.message
          : outcome.error
            ? String(outcome.error)
            : undefined;
      appendRunLog({
        time: startedAt.toISOString(),
        runId,
        agent: this.name,
        agentKind: this.agentKind(),
        channel,
        prompt: input.prompt,
        params: input.params,
        text: textParts.join(""),
        toolCalls,
        numTurns: outcome.summary?.numTurns,
        durationMs: outcome.summary?.durationMs,
        usage: outcome.summary?.usage,
        sessionId: outcome.summary?.sessionId,
        isError,
        error: errorMessage,
        errorSource: outcome.summary?.errorSource,
        retryable: outcome.summary?.retryable,
      });
      appendTraceLog({
        runId,
        time: startedAt.toISOString(),
        agent: this.name,
        agentKind: this.agentKind(),
        channel,
        prompt: String(truncate(input.prompt, 2000)),
        params: input.params,
        sessionId: outcome.summary?.sessionId,
        numTurns: outcome.summary?.numTurns,
        durationMs: outcome.summary?.durationMs,
        usage: outcome.summary?.usage,
        isError,
        error: errorMessage,
        errorSource: outcome.summary?.errorSource,
        retryable: outcome.summary?.retryable,
        events: traceEvents,
        ...(droppedEvents > 0 ? { droppedEvents } : {}),
      });
      await this.afterRun(runInput, outcome);
      if (perRunIsolated && runInput.cwd) {
        rmSync(runInput.cwd, { recursive: true, force: true });
      }
    }
  }
}
