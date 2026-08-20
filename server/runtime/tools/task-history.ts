import { tool } from "ai";
import { z } from "zod";
import {
  getTaskArchiveRecord,
  renderArchiveLine,
  searchTaskArchive,
  type TaskArchiveRecord,
} from "../../core/task-archive.js";

/**
 * 任务档案查询工具（员工与主管共用实现，作用域由构造参数定死）。
 *
 * 为什么必须是工具、不能让它们自己 grep 归档目录：
 * - chatId → 文件名的转义是**有损**的（所有非 `\w-` 变 `_`，见 workbench 的 safeKey 注释），
 *   靠模型拼路径必然拼错，而拼错的结果是「查不到」——它会当成「没这回事」继续往下说。
 * - `logs/` 被敏感路径规则整个拦掉，声明了 readRoots 的岗位根本读不到执行记录，
 *   于是「能不能查历史」变成了「你的岗位配置碰巧给不给你读」这种随机结果。
 * - 自由 grep 会把整月档案灌进上下文；工具能强制「先摘要、要细节再按 taskId 取」。
 *
 * 作用域：`scopeAgent` 一给，就只查得到这个员工自己的记录（模型改不了这个参数）。
 * 主管侧不传，查全团队。
 */

const searchParams = z.object({
  keyword: z
    .string()
    .optional()
    .describe("关键词，在标题 / 结论 / 关键决策 / 产出物里做子串匹配（不区分大小写）"),
  chatId: z.string().optional().describe("限定某个会话；不填则跨会话查"),
  state: z.enum(["done", "failed", "cancelled"]).optional().describe("只看某种终态"),
  since: z.string().optional().describe("起始日期 YYYY-MM-DD（含当天）"),
  limit: z.number().int().optional().describe("最多返回几条，默认 10、上限 50"),
});

function renderResults(recs: TaskArchiveRecord[], scopeAgent?: string): string {
  if (recs.length === 0) {
    return scopeAgent
      ? "档案里没有匹配的记录（只查你自己的历史任务）。换个关键词，或放宽条件再试。"
      : "档案里没有匹配的记录。换个关键词，或放宽条件再试。";
  }
  const lines = recs.map((r) =>
    scopeAgent ? renderArchiveLine(r) : `${renderArchiveLine(r)}\n  └ 执行人：${r.agentName}`,
  );
  return [
    `命中 ${recs.length} 条（新到旧）：`,
    ...lines,
    "",
    "要某条的完整档案（产出物 / 验证 / 风险 / 关键决策 / 当时的笔记路径）→ 用 get_task_record 按任务号取。",
  ].join("\n");
}

/** 查历史任务：返回摘要列表，细节走 get_task_record 二级披露 */
export function buildSearchTaskHistoryTool(scopeAgent?: string) {
  return tool({
    description: [
      scopeAgent
        ? "查**你自己**做过的历史任务档案（跨会话、长期保留）。"
        : "查全团队的历史任务档案（跨会话、长期保留，可按员工过滤）。",
      "什么时候用：这活似曾相识、想知道上次怎么结的；用户提到「之前那个/上次那件」但你上下文里没有；",
      "要确认某个结论/产出物当时到底是什么。",
      "开场注入的只是最近几条，更早的一律靠这里查——**不要**去猜归档文件路径自己读。",
    ].join("\n"),
    inputSchema: scopeAgent
      ? searchParams
      : searchParams.extend({
          agentName: z.string().optional().describe("限定某位员工的路由名；不填则查全部"),
        }),
    execute: async (input) => {
      const q = input as z.infer<typeof searchParams> & { agentName?: string };
      const recs = searchTaskArchive({
        ...(q.keyword ? { keyword: q.keyword } : {}),
        ...(q.chatId ? { chatId: q.chatId } : {}),
        ...(q.state ? { state: q.state } : {}),
        ...(q.since ? { since: q.since } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
        // 员工侧作用域是硬的：入参里根本没有 agentName 这一项，改不了
        ...(scopeAgent ? { agentName: scopeAgent } : q.agentName ? { agentName: q.agentName } : {}),
      });
      return renderResults(recs, scopeAgent);
    },
  });
}

/** 取单条档案全文 */
export function buildGetTaskRecordTool(scopeAgent?: string) {
  return tool({
    description:
      "按任务号取一条历史任务的完整档案（结论 / 产出物 / 验证 / 风险 / 关键决策 / 验收标准 / 当时的笔记路径）。" +
      "任务号从 search_task_history 的结果里来。",
    inputSchema: z.object({
      taskId: z.string().describe("任务号（不带 # 号）"),
    }),
    execute: async ({ taskId }) => {
      const rec = getTaskArchiveRecord(taskId.replace(/^#/, ""));
      if (!rec) return `档案里没有任务 #${taskId}。可能任务号不对，或它还没收尾（进行中的任务不在档案里）。`;
      if (scopeAgent && rec.agentName !== scopeAgent) {
        // 越权的正确回应是「没有」而不是「不给你看」：后者等于确认了它的存在
        return `档案里没有任务 #${taskId}。`;
      }
      const day = new Date(rec.at).toISOString().slice(0, 19).replace("T", " ");
      return [
        `任务 #${rec.taskId}｜${rec.state}｜${day}`,
        scopeAgent ? "" : `执行人：${rec.agentName}${rec.agentKind === "temp" ? "（临时工）" : ""}`,
        `会话：${rec.chatId}${rec.channel ? `（${rec.channel}）` : ""}`,
        `标题：${rec.title}`,
        rec.acceptance ? `验收标准：${rec.acceptance}` : "",
        rec.conclusion ? `结论：${rec.conclusion}` : "",
        rec.deliverables ? `产出物：${rec.deliverables}` : "",
        rec.verification ? `验证：${rec.verification}` : "",
        rec.risks ? `风险 / 遗留：${rec.risks}` : "",
        rec.decisions ? `关键决策：${rec.decisions}` : "",
        rec.error ? `失败原因：${rec.error}` : "",
        rec.reassigns ? `改派过 ${rec.reassigns} 次` : "",
        rec.noteFile ? `当时的随手笔记（要过程原文时读它）：${rec.noteFile}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });
}
