import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import { logDir } from "../config/paths.js";
import { getAgent } from "../agents/registry.js";
import { loadAgentProfile } from "../config/agent-profile.js";
import { collectRun } from "./runner.js";
import { harvestRoots } from "./case-harvest.js";
import { extractJson } from "../bench/judge-contract.js";
import type { ContractAssertion } from "./contract-assertions.js";

/**
 * 「用户负反馈」型待审 case 的断言起草人（case-drafter）执行器。
 *
 * 为什么独立：契约类断言可以从 profile 客观派生，内容类断言（该说什么/不该说什么/该调什么工具）
 * 得看这次执行到底错在哪。让被评的岗位、评测师或优化师自己写这条断言都有偏见——被告写判决书、
 * 出题人判自己的题、被测的量自己的尺子。所以专设一个提示词冻结的独立岗位。
 *
 * 触发点在 case-harvest.ts：一条 case 复现次数达阈值 + `needsApproval=true`（用户负反馈来源）
 * 时**异步 fire-and-forget** 起草一次，草稿落 `bench/candidates/<agent>/<caseId>/draft/`。
 * 不阻塞采集主流程——采集跑在任务收尾 hook 里，同步等 LLM 会拖慢任务结束。
 */

/** 起草人在提示里被允许的断言类型（3 种），与 ContractAssertion.type 的子集一一映射 */
const DRAFT_TYPES = new Set(["answer_contains", "answer_missing", "must_call_tool"] as const);
type DraftType = "answer_contains" | "answer_missing" | "must_call_tool";

interface DraftedAssertion {
  id: string;
  type: DraftType;
  pattern?: string;
  toolPattern?: string;
  objective?: string;
}

/** 起草状态：读取草稿目录时靠这个决定推文说「起草中」还是「已完成」 */
export type DraftStatus =
  | { state: "pending"; startedAt: string }
  | { state: "ok"; finishedAt: string; count: number; rationale?: string; notes?: string }
  | { state: "failed"; finishedAt: string; reason: string };

export interface DraftedCase {
  status: DraftStatus;
  /** 已过白名单校验、可直接合并进 case.assertions 的断言集合 */
  assertions: ContractAssertion[];
}

const RUNS_LOOKBACK_DAYS = 14;

function draftDir(agentId: string, caseId: string): string {
  return join(harvestRoots().candidates, agentId, caseId, "draft");
}

function writeStatus(dir: string, status: DraftStatus): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "status.json.tmp");
  const target = join(dir, "status.json");
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, "utf-8");
  renameSync(tmp, target);
}

/**
 * 按 runId 从 <repo>/logs/runs-*.jsonl 反查那次执行的答复原文。
 * 只扫最近 N 天：起草在「复现 ≥ MIN_REPRODUCTIONS」时触发，最近一次运行一定在近期，
 * 翻更早的日志既慢又没用。
 */
function findPriorAnswer(runIds: string[]): string | undefined {
  if (!runIds.length || !existsSync(logDir)) return undefined;
  const wanted = new Set(runIds);
  const files = readdirSync(logDir)
    .filter((name) => /^runs-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .slice(-RUNS_LOOKBACK_DAYS);
  for (const name of files.reverse()) {
    let content: string;
    try {
      content = readFileSync(join(logDir, name), "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { runId?: string; text?: string };
        if (rec.runId && wanted.has(rec.runId) && typeof rec.text === "string") {
          return rec.text;
        }
      } catch {
        /* 半行/损坏行跳过 */
      }
    }
  }
  return undefined;
}

/**
 * 把起草人产的原始 JSON 校验并映射成 ContractAssertion。
 * 白名单校验的目的是**兜住起草人跑偏**：它可能返回未知 type、写岗位没有的工具、id 重复、
 * pattern 是无效正则——这里一律丢弃单条而非整份，宁少勿滥。
 */
function normalize(
  draft: { assertions?: unknown },
  agentTools: string[],
): { assertions: ContractAssertion[]; skipped: number } {
  const out: ContractAssertion[] = [];
  const seenId = new Set<string>();
  let skipped = 0;
  const list = Array.isArray(draft.assertions) ? draft.assertions : [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      skipped++;
      continue;
    }
    const item = raw as DraftedAssertion;
    const type = item.type;
    if (!DRAFT_TYPES.has(type)) {
      skipped++;
      continue;
    }
    const id = (item.id ?? "").trim();
    if (!id || seenId.has(id)) {
      skipped++;
      continue;
    }
    seenId.add(id);
    const objective = (item.objective ?? "").trim() || `起草断言 ${id}`;

    if (type === "answer_contains" || type === "answer_missing") {
      const pattern = (item.pattern ?? "").trim();
      if (!pattern) {
        skipped++;
        continue;
      }
      try {
        new RegExp(pattern, "i");
      } catch {
        skipped++;
        continue;
      }
      out.push({
        id,
        type: "answer_match",
        pattern,
        negate: type === "answer_missing",
        objective,
        scoring: ["completion", "quality"],
        allowEquivalent: false,
      });
    } else {
      // must_call_tool
      const toolPattern = (item.toolPattern ?? "").trim();
      if (!toolPattern) {
        skipped++;
        continue;
      }
      let re: RegExp;
      try {
        re = new RegExp(toolPattern);
      } catch {
        skipped++;
        continue;
      }
      // 岗位工具白名单外的调用是无效断言：判据永远不通过
      if (agentTools.length && !agentTools.some((tool) => re.test(tool))) {
        skipped++;
        continue;
      }
      out.push({
        id,
        type: "required_call",
        selector: { toolPattern },
        objective,
        scoring: ["completion", "tool"],
        allowEquivalent: false,
      });
    }
  }
  return { assertions: out, skipped };
}

/** 读一份已落盘的草稿；不存在返回 undefined，用于 pendingCasesBrief 判断「有没有起草结果」 */
export function readCaseDraft(agentId: string, caseId: string): DraftedCase | undefined {
  const dir = draftDir(agentId, caseId);
  const statusFile = join(dir, "status.json");
  if (!existsSync(statusFile)) return undefined;
  let status: DraftStatus;
  try {
    status = JSON.parse(readFileSync(statusFile, "utf-8")) as DraftStatus;
  } catch {
    return undefined;
  }
  let assertions: ContractAssertion[] = [];
  const assertionsFile = join(dir, "assertions.json");
  if (existsSync(assertionsFile)) {
    try {
      const raw = JSON.parse(readFileSync(assertionsFile, "utf-8")) as {
        assertions?: ContractAssertion[];
      };
      if (Array.isArray(raw.assertions)) assertions = raw.assertions;
    } catch {
      /* 单文件损坏不影响 status 展示 */
    }
  }
  return { status, assertions };
}

export interface DraftInput {
  agentId: string;
  caseId: string;
  prompt: string;
  feedbackText?: string;
  runIds: string[];
}

/**
 * 起草一份断言草稿。**永不抛出**——异步 fire-and-forget 调用，抛到调用方那里也没人接。
 * 全部错误都写进 draft/status.json 的 failed 状态，pendingCasesBrief 会渲染出来让人看见。
 */
export async function draftCaseAssertions(input: DraftInput): Promise<DraftedCase> {
  const dir = draftDir(input.agentId, input.caseId);
  const started = new Date().toISOString();
  writeStatus(dir, { state: "pending", startedAt: started });

  const finish = (status: DraftStatus, assertions: ContractAssertion[] = []): DraftedCase => {
    writeStatus(dir, status);
    if (status.state === "ok") {
      writeFileSync(
        join(dir, "assertions.json"),
        `${JSON.stringify({ schemaVersion: 1, assertions }, null, 2)}\n`,
        "utf-8",
      );
    }
    return { status, assertions };
  };

  const profile = loadAgentProfile(input.agentId);
  if (!profile) {
    return finish({
      state: "failed",
      finishedAt: new Date().toISOString(),
      reason: `岗位 ${input.agentId} 不存在`,
    });
  }

  const drafter = getAgent("case-drafter");
  if (!drafter) {
    return finish({
      state: "failed",
      finishedAt: new Date().toISOString(),
      reason: "断言起草人岗位 case-drafter 未注册（缺 config/agents/case-drafter.json）",
    });
  }

  const priorAnswer = findPriorAnswer(input.runIds) ?? "";
  const agentTools = profile.tools ?? [];

  const collected = await collectRun(
    drafter.run({
      prompt:
        "为下面这条用户负反馈型的待审 case 起草一小组零 LLM 断言。只返回 JSON。\n\n" +
        `caseId：${input.caseId}\n岗位：${input.agentId}`,
      // 起草人不注入经验库：判据必须只来自本 case 的四段输入，跨 case 复用会让口径漂
      memory: "off",
      params: {
        channel: "bench",
        chatType: "private",
        senderName: "bench",
        agentId: input.agentId,
        agentDescription: profile.description ?? "（该岗位未写描述）",
        agentTools: agentTools.length ? agentTools.join(" / ") : "（未声明工具白名单）",
        casePrompt: input.prompt,
        feedbackText: input.feedbackText ?? "（该 case 无用户负反馈原话）",
        priorAnswer: priorAnswer || "（未从 runs 日志找回当次答复原文，请仅凭提问与反馈起草）",
        knowledgeRoot: config.knowledgeDir,
      },
    }),
  );

  if (collected.summary?.isError) {
    return finish({
      state: "failed",
      finishedAt: new Date().toISOString(),
      reason: `起草人执行失败：${String(collected.summary.result ?? "").slice(0, 300)}`,
    });
  }

  let parsed: { assertions?: unknown; rationale?: unknown; notes?: unknown };
  try {
    parsed = extractJson(collected.text) as typeof parsed;
  } catch (error) {
    return finish({
      state: "failed",
      finishedAt: new Date().toISOString(),
      reason: `起草人产出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const { assertions, skipped } = normalize(parsed, agentTools);
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
  const notes = typeof parsed.notes === "string" ? parsed.notes : "";
  if (rationale || notes) {
    writeFileSync(
      join(dir, "rationale.md"),
      [
        rationale && `## 起草思路\n\n${rationale}`,
        notes && `## 起草人 notes\n\n${notes}`,
        skipped ? `\n> 白名单校验丢弃了 ${skipped} 条不合规草稿断言。` : "",
      ]
        .filter(Boolean)
        .join("\n\n") + "\n",
      "utf-8",
    );
  }

  return finish(
    {
      state: "ok",
      finishedAt: new Date().toISOString(),
      count: assertions.length,
      ...(rationale ? { rationale } : {}),
      ...(notes ? { notes } : {}),
    },
    assertions,
  );
}
