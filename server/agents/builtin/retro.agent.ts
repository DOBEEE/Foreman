import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config/index.js";
import { LOG_DIR, agentActiveOn } from "../../core/logger.js";
import { MEMORY_ROOT, memoryDirOf, indexFileOf, dailyFileOf } from "../../core/memory.js";
import { cleanupNotes, noteFilesForRetro, NOTES_LOOKBACK_DAYS, NOTES_TTL_DAYS } from "../../core/notes.js";
import { feedbackFile, hasFeedback, hasFeedbackFor } from "../../core/feedback.js";
import { bossChatsOn, bossLogFile } from "../../core/boss-log.js";
import {
  BOSS_MEMORY_BUDGET,
  bossMemoryDirs,
  chatMemoryPath,
  userMemoryPath,
} from "../../boss/boss-memory.js";
import { collectRun, type AgentEvent, type RunInput } from "../../core/runner.js";
import { BaseAgent } from "../base-agent.js";
import { listAgents, getAgent } from "../registry.js";

/**
 * 每天最多复盘几个会话的主管判断：给开销封顶。
 * 按当天决策条数取最活跃的几个——判断做得最多的会话，素材密度也最高。
 */
const BOSS_RETRO_MAX_CHATS = 3;

/** distill 类别 → topic 分片文件名（稳定、文件名安全） */
function topicSlug(index: number): string {
  return `topic-${index + 1}`;
}

/** 取产出末尾的收尾结论（LLM 的总结在最后），而不是开头的过程叙述 */
function tailSummary(text: string, max = 220): string {
  const paras = text
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const last = paras[paras.length - 1] ?? "";
  return last.length > max ? `…${last.slice(-max)}` : last;
}

/**
 * 复盘员工：每天对每个「参与复盘的岗位」做一次独立 session 复盘。
 * - 每个员工一个干净 session（不 resume），上下文互不污染
 * - 按该员工 retroSpec.distill 规则提炼，写入其自己的 memory 子目录
 * - memoryWriteScope 逐员工切换，写入范围 hook 只放行当前员工目录
 * 产物随仓库提交（人审入库）；不在此自动 git 操作。
 */
export class RetroAgent extends BaseAgent {
  readonly name = "retro";

  /** 复盘对象：声明了 retroSpec.enabled 且非自身的员工 */
  private targets(): BaseAgent[] {
    return listAgents()
      .map((a) => getAgent(a.name)!)
      .filter((a) => a.name !== this.name && a.retroSpec?.enabled);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private shiftDate(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * 该岗位今天到底要不要复盘。返回 undefined = 跳过（当天没活动、也没有需要补的历史）。
   *
   * 两条触发：
   * 1. **当天有活动**：runs 里有它的 run，或有当天笔记，或当天有针对它的用户反馈
   *    （反馈是最高价值素材，哪怕没新 run 也必须复盘）。
   * 2. **历史补漏**：回看窗口内某天有活动、却没留下当天复盘记录（那天复盘没跑成，
   *    比如撞上模型授权连环失败）——补跑，兜住「昨天复盘挂了今天不理」的坑。
   *
   * 没活动又没欠账的岗位直接跳过：开一个独立 session 让它「今天没活动」也是纯烧 token。
   */
  private retroReason(agentName: string, date: string): string | undefined {
    const activeToday =
      agentActiveOn(agentName, date) ||
      noteFilesForRetro(agentName, date, 1).length > 0 ||
      hasFeedbackFor(agentName, date);
    if (activeToday) return "当天有活动";
    // 今天已经产出过复盘记录（含补跑）就不再重复——避免同一天被触发两次。
    // 补跑会用今天的日期写 daily（buildPromptFor 走 today），且 notes 自带 3 天回看，
    // 昨天漏掉的笔记会在今天这轮一并蒸馏进经验库，无需回填历史 daily。
    if (existsSync(dailyFileOf(agentName, date))) return undefined;
    // 补漏：往前看,有活动但那天没留下复盘记录（那天复盘没跑成）→ 补跑一轮。
    for (let i = 1; i < NOTES_LOOKBACK_DAYS; i++) {
      const day = this.shiftDate(date, -i);
      if (agentActiveOn(agentName, day) && !existsSync(dailyFileOf(agentName, day))) {
        return `补跑 ${day} 未完成的复盘`;
      }
    }
    return undefined;
  }

  private buildPromptFor(agent: BaseAgent, date: string): string {
    const spec = agent.retroSpec!;
    const dir = memoryDirOf(agent.name);
    const distillWithSlug = spec.distill.map(
      (d, i) => `- ${d}\n    → 沉淀到分片：topics/${topicSlug(i)}.md`,
    );
    return [
      `你是复盘员工，今天为「${agent.name}」岗位做每日复盘。目标：把今天的执行经历提炼成可复用经验，分类沉淀进该岗位的分层经验库。`,
      "",
      "## 应沉淀的类别（每类对应一个分片文件）",
      distillWithSlug.join("\n"),
      spec.exclude?.length
        ? `\n## 必须排除\n${spec.exclude.map((e) => `- ${e}`).join("\n")}`
        : "",
      "",
      "## 数据源（用 Read/Grep/Bash 自行读取，只读）",
      `- **员工随手笔记**（最高信号密度，先读）：${noteFilesForRetro(agent.name, date).join("、") || "（今天没有笔记）"}`,
      `- 执行 trace：${LOG_DIR}traces-${date}.jsonl（grep 过滤 "agent":"${agent.name}"）`,
      `- 运行汇总：${LOG_DIR}runs-${date}.jsonl`,
      `- 审计：${LOG_DIR}audit-${date}.jsonl`,
      hasFeedback(date)
        ? `- **用户反馈**（唯一的外部真相，务必读）：${feedbackFile(date)}（grep 过滤 "agentName":"${agent.name}"）`
        : "- 用户反馈：今天没有记录",
      "",
      "### 三类数据源怎么配合（重要）",
      "- 笔记是员工**主动认定值得留下**的判断与教训 —— 提供线索、动机、废弃路径，这些在 trace 里推不出来。",
      "- trace 是**客观事实** —— 真实调用了什么、返回了什么。",
      "- 用户反馈是**外部真相** —— 笔记与 trace 都是系统内部视角（主管的验收也是自我评判），只有用户说了才知道事情到底办好没办好。",
      "- **笔记里的结论必须能在 trace 里对上**才能沉淀；两者冲突时**一律以 trace 为准**，并在下面的当天复盘记录里注明「员工笔记与实际执行不符」。",
      "- 绝不把笔记里未经验证的推测当成经验写进经验库 —— 错误认知一旦固化，比没有经验更糟。",
      "",
      "### 用户反馈怎么用（有纪律）",
      "- **负反馈优先**：用户说「不对/还是不行/又错了」的任务最值得深挖 —— 哪怕当时任务标了 done、验收也说通过。**这种「系统以为成功、用户说失败」的落差是最高价值的复盘素材**，必须回到 trace 找出到底哪一步偏了。",
      "- **正反馈不等于做对了**：用户可能只是客气，或当时还没发现问题。正反馈只能用来确认「这条做法值得保留」，不能仅凭它就把某种做法写成经验。",
      "- **反馈是待核查线索，不是分数**。**绝不能**沉淀出「怎么让用户满意」这类经验 —— 那会把员工引向讨好而不是做对。要沉淀的是「用户不满的那个技术原因是什么、下次怎么避免」。",
      "- 反馈记录里 `context.bossAssists > 0` 时要留神：那说明主管代替用户回答过问题，负反馈**可能是代答答错了**而不是员工的问题 —— 分清责任，别冤枉员工（这种情况写进当天复盘记录，供优化师改主管侧的策略）。",
      "- 反馈的 `taskId` 为空表示归属不明，只能当整体氛围参考，不要硬套到某个任务上。",
      "",
      "## 产物（仅允许写 " + dir + " 内的文件，写别处会被拦截）",
      `1. 当天复盘记录：${dailyFileOf(agent.name, date)}（覆盖写当天要点）`,
      `2. 分类分片：${dir}topics/<类别>.md —— 按上面每类对应的分片文件名，把该类新经验**增量合并**进去（先 Read 现有分片，去重后追加，绝不整体重写、不删旧条目；每条尽量附来源 file:line 或 taskId）`,
      `3. 索引：${indexFileOf(agent.name)} —— 维护「一行摘要 → topics/<x>.md」的索引，为本次新增/更新的经验补上或更新对应摘要行（索引只放摘要，不放细节全文）`,
      "",
      "## 要求",
      "- 分层原则：索引只放一句话摘要 + 分片路径；细节全文只进分片。这样 agent 平时只加载索引，需要时再按需读分片。",
      "- 增量合并、去重在**单个分片内**进行，避免重复条目。",
      "- 今天该岗位若无可提炼的经验，daily 写一行说明即可，不要编造，也不要动索引/分片。",
      "- 完成后一句话汇报：更新了哪些分片、新增几条、索引是否更新。",
    ].join("\n");
  }

  /**
   * 主管复盘的提示词。
   *
   * 复盘对象与员工完全不同：主管不产出交付物，他产出的是**判断**——这活派给谁、
   * 简报怎么写、要不要代答、验收判过还是打回。所以素材不是 trace 而是决策日志，
   * 沉淀去处也不是团队经验库（那是员工的技术资产），而是他自己的两层运行时记忆。
   */
  private buildBossPromptFor(chatId: string, date: string): string {
    const { chatDir, userDir } = bossMemoryDirs();
    return [
      `你是复盘员工，今天为**主管**（boss，团队里派活的那个人）复盘他在会话 ${chatId} 里的判断质量。`,
      "主管不产出交付物，他产出的是**判断**：这活派给谁（编队 / 单人 / 现招临时工）、派工简报怎么写、",
      "要不要替用户代答、验收判过还是打回。你要复盘的就是这些判断，不是员工干得好不好。",
      "",
      "## 数据源（用 Read/Grep/Bash 自行读取，只读）",
      `- **主管决策日志**（核心素材）：${bossLogFile(date)}（用 \`grep -F '"chatId":"${chatId}"'\` 过滤——chatId 里可能有 + / = 这类字符，必须按字面量匹配）`,
      "  · kind 含义：intent=本轮对话决策（自己答 / 派活 / 转达）、route=兜底选人、assist=代答或改派、review=验收裁决、handoff=串行交接裁决。",
      "  · 每条都带 output（判断依据原文）与 summary，判断对不对就看这里。",
      hasFeedback(date)
        ? `- **用户反馈**（唯一的外部真相）：${feedbackFile(date)}`
        : "- 用户反馈：今天没有记录",
      `- 会话原文（用户到底要什么、主管怎么回的）：${join(config.runtimeDir, "chats")}/ 下对应 ${chatId} 的 json`,
      `- 执行 trace（要核对某个任务实际怎么跑的时候才读）：${LOG_DIR}traces-${date}.jsonl`,
      "",
      "## 该记什么（判据：这条写下来，能改变他下次的判断吗？）",
      "- **派工教训**：某类诉求上次派错了、或该招临时工却硬派给了沾边的人 → 写成规则：「遇到 X 这类诉求 → Y」。",
      "- **本会话的约定与悬念**：用户说过的口径（「主干不要动」「先给我看草稿」）、还欠着的事（「等 A 跑完再说 B」）。",
      "- **代答与验收的失手**：代答答错过什么、验收放过了什么没做完的活。",
      "反过来，这些**不要**记：员工的技术细节（那是员工经验库的事）、一次性的具体路径与数据、任何凭据密钥、",
      "以及「怎么让用户满意」这类讨好式结论——要记的是「用户不满的那个真实原因 + 下次怎么避免」。",
      "",
      "## 产物（只写这两个文件，别动别处）",
      `1. 会话公共记忆：${chatMemoryPath(chatId)} —— 本会话所有人共享（约定 / 悬念 / 派工规则）。`,
      `2. 个人记忆：${userDir}/<senderId>.md —— 跟人跨会话（称呼、沟通偏好）。senderId 从审计日志取：${LOG_DIR}audit-${date}.jsonl 的 senderId 字段；同一会话可能有多个人。`,
      `   （示例路径：${userMemoryPath("<senderId>")}；目录已建好：${chatDir}、${userDir}）`,
      "",
      "## 要求",
      "- **增量合并**：先 Read 现有文件，去重后补充或修订，绝不整体重写、不删掉仍然成立的旧条目。",
      `- **控制体量**：每个文件不超过约 ${BOSS_MEMORY_BUDGET} 字符——超了会在注入时被静默截断，等于白写。快到上限就合并同类项、删掉已经过时的条目，宁可少而准。`,
      "- 每条尽量短，一句一条，能附 taskId 就附上。写成**祈使规则**，不要写成故事叙述。",
      "- 今天确实没有值得记的判断 → 什么都不写，直接说明；**不要为了有产出而编条目**（记忆是每轮注入他上下文的东西，写错比不写更糟）。",
      "- 完成后一句话汇报：改了哪几个文件、各新增几条。",
    ].join("\n");
  }

  /** 逐员工独立 session 复盘（覆写 run，不走单 query 主流程） */
  async *run(_input: RunInput): AsyncGenerator<AgentEvent> {
    this.ensureCwd();
    const date = this.today();
    const targets = this.targets();
    // 主管侧独立成账：他当天可能做了一堆判断而员工一个都没跑（全是他自己答的），
    // 所以这份清单不能挂在员工侧的活动判断下面
    const bossChats = bossChatsOn(date).slice(0, BOSS_RETRO_MAX_CHATS);

    // 只复盘「当天有活动或有历史欠账」的岗位：没干活的岗位照开 session 是纯烧 token。
    const active: Array<{ agent: BaseAgent; reason: string }> = [];
    const skipped: string[] = [];
    for (const agent of targets) {
      const reason = this.retroReason(agent.name, date);
      if (reason) active.push({ agent, reason });
      else skipped.push(agent.name);
    }

    if (active.length === 0 && bossChats.length === 0) {
      const note =
        targets.length === 0
          ? "没有参与复盘的岗位（retroSpec.enabled），主管当天也没有决策记录。"
          : `今天 ${targets.length} 个岗位都没有活动、主管也没有决策记录，无需复盘（跳过：${skipped.join("、")}）。`;
      cleanupNotes();
      yield { event: "text", data: { text: `# 每日复盘 ${date}\n${note}` } };
      yield { event: "result", data: { subtype: "success", isError: false, numTurns: 0 } };
      return;
    }

    // 先整树 pending，便于 boss/CLI 渲染进度（只挂要跑的岗位与会话）
    for (const { agent } of active) {
      yield { event: "progress", data: { id: agent.name, title: `复盘 ${agent.name}`, status: "pending" } };
    }
    for (const { chatId } of bossChats) {
      yield { event: "progress", data: { id: `boss:${chatId}`, title: `复盘主管判断 ${chatId}`, status: "pending" } };
    }

    const summaries: string[] = [];
    let totalTurns = 0;
    let failedCount = 0;

    for (const { agent } of active) {
      yield { event: "progress", data: { id: agent.name, title: `复盘 ${agent.name}`, status: "running" } };
      // 关键：切换写入放行范围到当前员工，独立 session（不 resume）
      this.memoryWriteScope = agent.name;
      try {
        const { text, summary } = await collectRun(
          this.runInstrumented({
            prompt: this.buildPromptFor(agent, date),
            persistSession: false,
            maxTurns: this.profile.maxTurns,
            params: { retroTarget: agent.name, retroDate: date },
          }),
        );
        totalTurns += summary?.numTurns ?? 0;
        const conclusion = tailSummary(text) || "（无输出）";
        // isError（含步数用满）表示这个岗位并没跑完，不能混在成功里报
        if (summary?.isError ?? !summary) {
          failedCount++;
          summaries.push(
            `- ${agent.name}: ⚠️ 未完成（${summary?.subtype ?? "中断"}，${summary?.numTurns ?? "?"} 轮）· 最后进展：${conclusion}`,
          );
          yield { event: "progress", data: { id: agent.name, title: `复盘 ${agent.name}`, status: "failed" } };
        } else {
          summaries.push(`- ${agent.name}: ${conclusion}`);
          yield { event: "progress", data: { id: agent.name, title: `复盘 ${agent.name}`, status: "done" } };
        }
      } catch (error) {
        failedCount++;
        summaries.push(
          `- ${agent.name}: ⚠️ 复盘失败 ${error instanceof Error ? error.message : String(error)}`,
        );
        yield { event: "progress", data: { id: agent.name, title: `复盘 ${agent.name}`, status: "failed" } };
      } finally {
        this.memoryWriteScope = undefined;
      }
    }

    // ── 主管复盘：逐会话一个独立 session ──
    // 刻意**不设** memoryWriteScope：主管记忆在 <runtimeDir>/boss/memory 下、不属于团队经验库，
    // 而把 scope 留空正好让门禁继续禁止这一环误写任何员工的经验库。
    for (const { chatId, decisions } of bossChats) {
      const id = `boss:${chatId}`;
      const title = `复盘主管判断 ${chatId}`;
      yield { event: "progress", data: { id, title, status: "running" } };
      try {
        const { text, summary } = await collectRun(
          this.runInstrumented({
            prompt: this.buildBossPromptFor(chatId, date),
            persistSession: false,
            maxTurns: this.profile.maxTurns,
            params: { retroTarget: `boss:${chatId}`, retroDate: date },
          }),
        );
        totalTurns += summary?.numTurns ?? 0;
        const conclusion = tailSummary(text) || "（无输出）";
        if (summary?.isError ?? !summary) {
          failedCount++;
          summaries.push(
            `- 主管@${chatId}（${decisions} 条决策）: ⚠️ 未完成（${summary?.subtype ?? "中断"}，${summary?.numTurns ?? "?"} 轮）· 最后进展：${conclusion}`,
          );
          yield { event: "progress", data: { id, title, status: "failed" } };
        } else {
          summaries.push(`- 主管@${chatId}（${decisions} 条决策）: ${conclusion}`);
          yield { event: "progress", data: { id, title, status: "done" } };
        }
      } catch (error) {
        failedCount++;
        summaries.push(
          `- 主管@${chatId}: ⚠️ 复盘失败 ${error instanceof Error ? error.message : String(error)}`,
        );
        yield { event: "progress", data: { id, title, status: "failed" } };
      }
    }

    const removed = cleanupNotes();

    const report = [
      `# 每日复盘 ${date}`,
      `经验库根目录：${MEMORY_ROOT}`,
      bossChats.length > 0 ? `主管记忆：${bossMemoryDirs().chatDir}（会话）｜${bossMemoryDirs().userDir}（个人）` : "",
      failedCount > 0
        ? `\n⚠️ ${failedCount}/${active.length + bossChats.length} 项没跑完，本次复盘**不完整**，对应的经验库 / 主管记忆未更新或只更新了一部分。`
        : "",
      "",
      ...summaries,
      "",
      skipped.length > 0
        ? `（跳过 ${skipped.length} 个当天无活动的岗位：${skipped.join("、")}）`
        : "",
      failedCount > 0
        ? `（已跑完的部分产物已落盘；未完成的需重跑复盘）`
        : "（员工经验库产物请 review 后提交 git；主管记忆属运行时数据，不进 git）",
      removed > 0 ? `（顺带清理了 ${removed} 个超过 ${NOTES_TTL_DAYS} 天的过期笔记文件）` : "",
    ]
      .filter((l) => l !== "")
      .join("\n");
    yield { event: "text", data: { text: report } };
    yield {
      event: "result",
      data: { subtype: "success", isError: false, numTurns: totalTurns },
    };
  }
}
