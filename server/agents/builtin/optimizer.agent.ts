import { existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ToolGuard } from "../../runtime/hooks.js";
import { config } from "../../config/index.js";
import { hiredProfilePath, listHiredProfiles } from "../../config/agent-profile.js";
import { LOG_DIR } from "../../core/logger.js";
import { dailyFileOf } from "../../core/memory.js";
import type { RunInput } from "../../core/runner.js";
import { agentsWithPendingProposal, proposalsDir } from "../../boss/proposals.js";
import { reportDir } from "../../bench/report.js";
import { BaseAgent } from "../base-agent.js";
import { getAgent, listAgents } from "../registry.js";

/** 报告输出目录：<repo>/logs/optimizer-reports/ */
const REPORTS_DIR = join(LOG_DIR, "optimizer-reports");

/** 分析对象之外一律禁读的敏感路径 */
const SENSITIVE_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)mcp\.servers\.json$/,
  /(^|\/)\.(ssh|aws|kube|claude)(\/|$)/,
  /(^|\/)(id_rsa|id_ed25519|\.npmrc|\.netrc)(\/|$)/,
  /\.(pem|key|p12|pfx|keystore)$/i,
];

/** 从工具入参里取出所有可能的路径字段 */
function extractPaths(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const record = toolInput as Record<string, unknown>;
  return ["file_path", "path", "notebook_path"]
    .map((key) => record[key])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** 枚举最近 N 天实际存在的日志文件绝对路径（含今天） */
function listRecentLogFiles(days: number): string[] {
  const files: string[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const day = new Date(now - i * 86400_000).toISOString().slice(0, 10);
    // feedback 一并纳入：trace 只说明「做了什么」，用户反馈才说明「办好没办好」
    for (const prefix of ["traces", "runs", "feedback"]) {
      const file = join(LOG_DIR, `${prefix}-${day}.jsonl`);
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

/**
 * 枚举窗口内各岗位的复盘当天记录（memory/<岗位>/daily/<date>.md），只返回存在的。
 *
 * 复盘的提示词反复要求把「员工笔记与实际执行不符」「boss 代答答错了、别冤枉员工」这类
 * 归因线索写进当天记录，明说是**供优化师排查**——但优化师的数据源长期只有
 * traces/runs/feedback，从不读它，这条交接是单向死信。
 * 这些结论在 trace 里推不出来：它们是复盘拿笔记逐条核对过 trace 之后的判断。
 */
function listRetroDailyFiles(days: number): string[] {
  const files: string[] = [];
  const now = Date.now();
  for (const listed of listAgents()) {
    const agent = getAgent(listed.name);
    if (!agent?.retroSpec?.enabled) continue;
    for (let i = 0; i < days; i++) {
      const day = new Date(now - i * 86400_000).toISOString().slice(0, 10);
      const file = dailyFileOf(listed.name, day);
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

/**
 * 枚举各岗位的一层回归报告（logs/bench-reports/<岗位>/latest.md）。
 *
 * 这是**比 trace 更强的信号**：报告里的每条 finding 都是「要求 vs 实际」的一对一陈述
 * （某条断言要求先检索再作答、实际没检索），而 trace 只是原始事件流，
 * 得先自己归纳出模式来。断言还带 route，直接说明这条该不该由优化师改。
 */
function listBenchReports(): Array<{ agentId: string; file: string }> {
  const out: Array<{ agentId: string; file: string }> = [];
  for (const profile of listHiredProfiles()) {
    const file = join(reportDir(profile.id), "latest.md");
    if (existsSync(file)) out.push({ agentId: profile.id, file });
  }
  return out;
}

function clampDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return config.optimizer.days;
  return Math.min(30, Math.max(1, Math.floor(n)));
}

/**
 * Optimizer：读执行 trace（logs/*.jsonl），归因分析**用户员工**的失败/低效模式，
 * 对其 systemPrompt 产出结构化优化提案（<userDir>/proposals/*.json）+ 分析报告。
 * 只写提案目录与报告目录，绝不直接改员工配置——由主管推送、用户批准后才应用。
 * 内置岗位的提示词随代码走 git，不在自动化范围内。
 */
export class OptimizerAgent extends BaseAgent {
  readonly name = "optimizer";

  /** Write 只许落提案目录 / 报告目录；读操作屏蔽凭据类敏感文件 */
  protected readonly sdkGuards: ToolGuard[] = [
    async (toolName, input) => {
      const deny = (reason: string) => {
        console.warn(`[optimizer] blocked ${toolName}: ${reason}`);
        return { deny: true as const, reason };
      };
      for (const raw of extractPaths(input)) {
        const target = resolve(config.serviceRoot, raw);
        if (toolName === "Write") {
          const inside = [REPORTS_DIR, proposalsDir()].some((dir) => {
            const rel = relative(dir, target);
            return rel !== "" && !rel.startsWith("..");
          });
          if (!inside) {
            return deny(
              `拒绝写入 ${raw}：optimizer 只允许写提案目录（${proposalsDir()}）与报告目录（${REPORTS_DIR}）`,
            );
          }
        } else if (SENSITIVE_PATTERNS.some((p) => p.test(target))) {
          return deny(`拒绝访问 ${raw}：凭据 / 密钥类文件不在分析范围内`);
        }
      }
      return { allow: true };
    },
  ];

  protected async beforeRun(): Promise<void> {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }

  /** 服务端预枚举日志文件、可优化员工与输出目录，避免模型猜文件名/日期/范围 */
  protected buildTemplateParams(input: RunInput): Record<string, unknown> {
    const days = clampDays(input.params?.days);
    const hired = listHiredProfiles();
    const hiredIds = new Set(hired.map((p) => p.id));
    const pendingIds = agentsWithPendingProposal();
    const requested =
      typeof input.params?.agent === "string" && input.params.agent
        ? input.params.agent
        : undefined;
    const agentFilter = requested
      ? hiredIds.has(requested)
        ? `仅分析 agent = "${requested}"`
        : `用户指定的 "${requested}" 不是用户员工（内置岗位不在优化范围内），本次直接说明并结束`
      : "分析下面清单里的全部用户员工";
    const logFiles = listRecentLogFiles(days);
    const runStamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace("T", "-")
      .replace(":", "");
    return {
      ...super.buildTemplateParams(input),
      benchReports: (() => {
        const reports = listBenchReports();
        return reports.length
          ? reports.map((r) => `- \`${r.agentId}\`：\`${r.file}\``).join("\n")
          : "（还没有任何一层回归报告——说明这些岗位尚未攒下采集 case，本次只能靠 trace 归纳）";
      })(),
      traceFiles: logFiles.length
        ? logFiles.map((f) => `- \`${f}\``).join("\n")
        : "（最近没有任何日志文件——直接在报告中说明无数据可分析并结束）",
      retroFiles: (() => {
        const files = listRetroDailyFiles(days);
        return files.length
          ? files.map((f) => `- \`${f}\``).join("\n")
          : "（窗口内没有复盘记录——可能是复盘没跑成，这本身值得在报告里提一句）";
      })(),
      agentFilter,
      days,
      hiredAgents: hired.length
        ? hired
            .map(
              (p) =>
                `- \`${p.id}\`（${p.displayName ?? p.id}）：配置文件 \`${hiredProfilePath(p.id)}\`` +
                (pendingIds.includes(p.id) ? " ⚠️ 已有待审提案，本次跳过" : ""),
            )
            .join("\n")
        : "（当前没有用户员工，直接说明无可优化对象并结束）",
      skipAgents: pendingIds.length
        ? pendingIds.map((id) => `\`${id}\``).join("、")
        : "（无）",
      proposalsDir: proposalsDir(),
      proposalIdPrefix: runStamp.replace(/[^\d]/g, "").slice(-8),
      reportsDir: REPORTS_DIR,
      runStamp,
    };
  }
}
