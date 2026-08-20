import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import { loadAgentProfile } from "../config/agent-profile.js";
import type { TraceRecord } from "./logger.js";
import type { FeedbackRecord } from "./feedback.js";
import { deriveContractAssertions, type ContractAssertion } from "./contract-assertions.js";
import { MISSING_CREDENTIAL_CODE } from "./onboarding.js";

/**
 * case 自动采集。
 *
 * 这是整条自进化链路里最容易出错的一环：如果失败的系统自己决定什么算 case，
 * 它可以只收简单的、跳过难的。所以采集器是**确定性代码而非 agent**，且判据只认两类
 * 不依赖自我评价的来源：
 *
 *   1. 用户负反馈（explicit / cancel）—— 外部真相，最硬
 *   2. 契约违规（零 LLM 可检出）—— 客观事实，边界是招人时就声明的
 *
 * **绝不采集基础设施故障**（限流、超时、鉴权失败、依赖缺失）。它们不是提示词问题，
 * 采进去只会让 case 集永久带上无法通过的噪声。实测教材：一次 429 + 一次 fetch failed
 * 直接废掉两轮评测，那期间「员工行为」毫无问题。
 *
 * 落盘规则：
 * - caseId **内容寻址**（prompt + 断言的哈希），两个实例采到同一失败会收敛到同一目录，
 *   天然幂等，不需要跨实例锁
 * - 原子写（tmp + rename），避免半个 case 目录被下游读到
 * - 先进 candidates/，复现 ≥2 次才升进 cases/：一次性抖动不该变成永久标准
 */

const MIN_REPRODUCTIONS = 2;

export interface HarvestRoots {
  root: string;
  cases: string;
  candidates: string;
}

export function harvestRoots(): HarvestRoots {
  const root = join(config.runtimeDir, "bench");
  return { root, cases: join(root, "cases"), candidates: join(root, "candidates") };
}

export type HarvestSourceKind = "user_feedback" | "contract_violation";

export interface HarvestedCase {
  schemaVersion: 1;
  caseId: string;
  agentId: string;
  /** 采集来源：决定这条 case 要不要人工审批 */
  source: HarvestSourceKind;
  /** 原始提问，作为 case 的输入 */
  prompt: string;
  /** 零 LLM 断言。内容层断言（answer_match）需人工/评测师补，采集器不猜 */
  assertions: ContractAssertion[];
  /** 溯源：能回到 trace 与反馈原文核对 */
  provenance: {
    runIds: string[];
    sessionIds: string[];
    feedbackText?: string;
    feedbackSignal?: FeedbackRecord["signal"];
    firstSeenAt: string;
    lastSeenAt: string;
    reproductions: number;
  };
}

export type HarvestOutcome =
  | { action: "skipped"; reason: string }
  | { action: "candidate"; caseId: string; reproductions: number; needsApproval: boolean }
  | { action: "promoted"; caseId: string; needsApproval: boolean };

/** 基础设施故障不算员工行为失败 —— 采进 case 集就是永久噪声 */
export function isInfrastructureFailure(
  record: Pick<TraceRecord, "errorSource" | "retryable" | "error">,
): boolean {
  if (record.errorSource === "model_gateway" || record.retryable === true) return true;
  // 缺模型凭据：纯 runtime 错误且不可重试，上面两条都盖不住。不排掉的话，
  // 新装用户没填 key → 拿到引导文案 → 回一句「这不对」，这条负反馈会变成一条
  // **永远无法通过**的 case，躺在每一个新装环境的回归套件里。
  return Boolean(record.error?.includes(MISSING_CREDENTIAL_CODE));
}

/** 内容寻址：同一个失败在任何实例上都收敛到同一 caseId，无需跨实例协调 */
export function caseIdFor(agentId: string, prompt: string, assertions: ContractAssertion[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ agentId, prompt: prompt.trim(), assertions }))
    .digest("hex")
    .slice(0, 8);
  return `${agentId}-${digest}`;
}

function readCase(dir: string): HarvestedCase | undefined {
  const file = join(dir, "case.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as HarvestedCase;
  } catch {
    return undefined;
  }
}

/** 原子写整个 case 目录：先写临时目录再 rename，避免下游读到半成品 */
function writeCaseDir(target: string, value: HarvestedCase): void {
  const staging = `${target}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "input"), { recursive: true });
  mkdirSync(join(staging, "oracle"), { recursive: true });
  writeFileSync(join(staging, "case.json"), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  writeFileSync(join(staging, "input", "prompt.md"), `${value.prompt.trim()}\n`, "utf-8");
  writeFileSync(
    join(staging, "oracle", "trace.json"),
    `${JSON.stringify({ schemaVersion: 1, assertions: value.assertions }, null, 2)}\n`,
    "utf-8",
  );
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, ".."), { recursive: true });
  renameSync(staging, target);
}

/**
 * 从一次执行采集 case。
 *
 * @param feedback 该次执行对应的用户负反馈（有则来源判为 user_feedback，需人工审批）
 */
export function harvestCase(record: TraceRecord, feedback?: FeedbackRecord): HarvestOutcome {
  if (isInfrastructureFailure(record)) {
    return { action: "skipped", reason: "基础设施故障（限流/超时/鉴权），不是员工行为问题" };
  }
  const negativeFeedback = feedback?.polarity === "negative" ? feedback : undefined;
  const profile = loadAgentProfile(record.agent);
  if (!profile) return { action: "skipped", reason: `岗位 ${record.agent} 不存在` };

  const assertions = deriveContractAssertions(profile);
  // 采集的两个合法来源。都不成立就跳过——「自评失败」不作为采集依据，
  // 否则等于让被测系统自己决定什么算失败，它可以只收简单的。
  const source: HarvestSourceKind | undefined = negativeFeedback
    ? "user_feedback"
    : assertions.length
      ? "contract_violation"
      : undefined;
  if (!source) {
    return { action: "skipped", reason: "既无用户负反馈，该岗位也没有可派生的契约断言" };
  }
  if (!record.prompt.trim()) return { action: "skipped", reason: "没有可复现的提问" };

  const roots = harvestRoots();
  const caseId = caseIdFor(record.agent, record.prompt, assertions);
  const promoted = join(roots.cases, record.agent, caseId);
  // 已经晋升的不再重复采集：oracle 一旦封存就进 caseSet 指纹，改它会让基线失效
  if (existsSync(promoted)) {
    return { action: "promoted", caseId, needsApproval: false };
  }

  const candidateDir = join(roots.candidates, record.agent, caseId);
  const existing = readCase(candidateDir);
  const now = record.time;
  const next: HarvestedCase = {
    schemaVersion: 1,
    caseId,
    agentId: record.agent,
    source,
    prompt: record.prompt,
    assertions,
    provenance: {
      runIds: [...new Set([...(existing?.provenance.runIds ?? []), record.runId])],
      sessionIds: [
        ...new Set([...(existing?.provenance.sessionIds ?? []), record.sessionId].filter((id): id is string => Boolean(id))),
      ],
      ...(negativeFeedback?.text ? { feedbackText: negativeFeedback.text } : {}),
      ...(negativeFeedback?.signal ? { feedbackSignal: negativeFeedback.signal } : {}),
      firstSeenAt: existing?.provenance.firstSeenAt ?? now,
      lastSeenAt: now,
      reproductions: (existing?.provenance.reproductions ?? 0) + 1,
    },
  };

  // 模型转写过的内容层断言才需要人审；契约类断言没引入新标准（边界是招人时定的）
  const needsApproval = source === "user_feedback";

  if (next.provenance.reproductions < MIN_REPRODUCTIONS) {
    writeCaseDir(candidateDir, next);
    return { action: "candidate", caseId, reproductions: next.provenance.reproductions, needsApproval };
  }
  // 复现够了：需人审的留在 candidates 等批准，纯客观的直接晋升
  if (needsApproval) {
    writeCaseDir(candidateDir, next);
    // 进入待审那一刻起草一次，让人工审批时能直接看到断言草稿。
    // fire-and-forget：起草人跑 LLM 有分钟级耗时，同步等会拖慢任务收尾 hook；
    // 起草结果落 draft/ 子目录，pendingCasesBrief 读到什么就渲染什么（起草中 / 已完成 / 失败）。
    // 只在还没有草稿目录时才起草，避免复现次数继续增长时反复重跑。
    const draftMarker = join(candidateDir, "draft", "status.json");
    if (!existsSync(draftMarker)) {
      void import("./case-drafter.js")
        .then(({ draftCaseAssertions }) =>
          draftCaseAssertions({
            agentId: next.agentId,
            caseId: next.caseId,
            prompt: next.prompt,
            ...(next.provenance.feedbackText ? { feedbackText: next.provenance.feedbackText } : {}),
            runIds: next.provenance.runIds,
          }),
        )
        .catch((error) => {
          console.warn(
            `[case-drafter] ${next.agentId}/${next.caseId} 起草异常:`,
            error instanceof Error ? error.message : String(error),
          );
        });
    }
    return { action: "candidate", caseId, reproductions: next.provenance.reproductions, needsApproval };
  }
  writeCaseDir(promoted, next);
  rmSync(candidateDir, { recursive: true, force: true });
  return { action: "promoted", caseId, needsApproval };
}

/**
 * 列出待人工批准的 case。
 *
 * 只列复现次数已达门槛的：没攒够的还在观察期，摆到人面前只会让批准变成走流程。
 * 这个批准是整条链上**唯一**能挡住「错误标准被永久固化」的地方——断言写错了，
 * 员工会为一条根本不该存在的标准反复被改，而且它会一直留在回归套件里。
 */
export function listPendingCases(agentId?: string): HarvestedCase[] {
  const roots = harvestRoots();
  if (!existsSync(roots.candidates)) return [];
  const agents = agentId ? [agentId] : readdirSync(roots.candidates);
  const out: HarvestedCase[] = [];
  for (const agent of agents) {
    const agentRoot = join(roots.candidates, agent);
    if (!existsSync(agentRoot)) continue;
    for (const caseId of readdirSync(agentRoot).sort()) {
      const value = readCase(join(agentRoot, caseId));
      if (value && value.provenance.reproductions >= MIN_REPRODUCTIONS) out.push(value);
    }
  }
  return out;
}

/** 人工批准一条待审 case：从 candidates 移进 cases */
export function approveHarvestedCase(agentId: string, caseId: string): { ok: boolean; message: string } {
  const roots = harvestRoots();
  const candidateDir = join(roots.candidates, agentId, caseId);
  const value = readCase(candidateDir);
  if (!value) return { ok: false, message: `没有待审 case ${agentId}/${caseId}` };
  if (value.provenance.reproductions < MIN_REPRODUCTIONS) {
    return {
      ok: false,
      message: `${caseId} 只复现过 ${value.provenance.reproductions} 次（需 ≥${MIN_REPRODUCTIONS}），先别固化成永久标准`,
    };
  }
  // 用户负反馈型 case 的断言由 case-drafter 起草并落在 draft/ 子目录。
  // 晋升时若 case.assertions 为空、且草稿就绪，就把草稿合并进正式断言——
  // 空断言的 case 晋升后回归跑等于「只判会不会崩，判不对错」，达不到守住负反馈的目的。
  // 用户手动编辑过 case.json 的 assertions 时不覆盖（保留人工判断）。
  let mergedFrom = "";
  if (value.assertions.length === 0) {
    const draftFile = join(candidateDir, "draft", "assertions.json");
    if (existsSync(draftFile)) {
      try {
        const raw = JSON.parse(readFileSync(draftFile, "utf-8")) as { assertions?: ContractAssertion[] };
        if (Array.isArray(raw.assertions) && raw.assertions.length > 0) {
          value.assertions = raw.assertions;
          mergedFrom = `，合并了 ${raw.assertions.length} 条起草人断言`;
        }
      } catch {
        /* 草稿损坏就当没有，用户可事后补 */
      }
    }
  }
  const targetDir = join(roots.cases, agentId, caseId);
  writeCaseDir(targetDir, value);
  // 保留起草溯源：rationale.md / notes 让将来 review 时能看到「这条断言是怎么起草出来的」
  const candidateDraft = join(candidateDir, "draft");
  if (existsSync(candidateDraft)) {
    const targetDraft = join(targetDir, "draft");
    rmSync(targetDraft, { recursive: true, force: true });
    try {
      renameSync(candidateDraft, targetDraft);
    } catch {
      /* 跨设备 rename 失败就丢草稿——晋升本身不该因此失败 */
    }
  }
  rmSync(candidateDir, { recursive: true, force: true });
  return { ok: true, message: `已晋升 ${agentId}/${caseId}（进 caseSet 指纹，现有基线需重新 promote）${mergedFrom}` };
}

/**
 * 按用户输入定位一条待审 case。
 *
 * 接受 `<caseId>` 或 `<agentId>/<caseId>` 两种写法：caseId 本身已经带岗位前缀
 * （`${agentId}-${digest}`），要求用户再写一遍岗位是多余的负担。
 */
export function resolvePendingCase(ref: string): HarvestedCase | undefined {
  const wanted = ref.trim();
  const [maybeAgent, maybeCase] = wanted.includes("/") ? wanted.split("/", 2) : [undefined, wanted];
  return listPendingCases(maybeAgent).find((item) => item.caseId === maybeCase);
}

/**
 * 丢弃一条待审 case。
 *
 * 需要它是因为「批准」不能是唯一出口：断言写错了、或那次负反馈其实是用户自己的误解，
 * 都得能把这条标准扔掉。没有丢弃通道，人就只会放着不管，待审队列越积越长，
 * 最后批准变成走流程——那正好废掉这个环节存在的意义。
 */
export function discardHarvestedCase(agentId: string, caseId: string): { ok: boolean; message: string } {
  const candidateDir = join(harvestRoots().candidates, agentId, caseId);
  if (!readCase(candidateDir)) return { ok: false, message: `没有待审 case ${agentId}/${caseId}` };
  rmSync(candidateDir, { recursive: true, force: true });
  // 刻意不做「永久黑名单」：同一问题若再复现两次，还是应该重新摆到人面前。
  // 一次判断失误不该让某类问题永远无法被采集。
  return { ok: true, message: `已丢弃 ${agentId}/${caseId}（若该问题再复现 ≥2 次会重新待审）` };
}

/** 待审 case 的文本摘要，供渠道回复与卡片用 */
export function pendingCasesBrief(): string | undefined {
  const pending = listPendingCases();
  if (!pending.length) return undefined;
  const lines = pending.map((item) => renderPendingCase(item));
  return (
    `有 ${pending.length} 条待审回归用例。批准后它会成为该岗位的**永久**评测标准，` +
    `所以请扫一眼断言写得对不对：\n\n${lines.join("\n\n")}\n\n` +
    `回「批准用例 <id>」收下，或「驳回用例 <id>」丢弃。`
  );
}

/**
 * 单条 case 的渲染。用户负反馈型会读起草人草稿，让推文里能直接看到「批准后会带上哪几条断言」——
 * 之前渲染成「断言：（无）」，人根本判断不出批不批。
 */
function renderPendingCase(item: HarvestedCase): string {
  const from = item.source === "user_feedback" ? "用户负反馈" : "契约违规";
  const header =
    `- \`${item.caseId}\`（${item.agentId}，来源：${from}，复现 ${item.provenance.reproductions} 次）`;
  const quote = item.provenance.feedbackText ? `\n  用户原话：${item.provenance.feedbackText}` : "";

  // 契约违规型：契约断言直接列 id，判据是「派生自 profile 的强制层」，人只判「要不要固化」
  if (item.source !== "user_feedback") {
    const contractIds = item.assertions.map((a) => a.id).join("、") || "（无）";
    return `${header}\n  契约断言：${contractIds}${quote}`;
  }

  // 用户负反馈型：优先读起草人草稿，让人能看到具体断言
  const draftRoot = join(harvestRoots().candidates, item.agentId, item.caseId, "draft");
  const statusFile = join(draftRoot, "status.json");
  const assertionsFile = join(draftRoot, "assertions.json");
  if (!existsSync(statusFile)) {
    return `${header}\n  ⏳ 起草中（case-drafter 尚未开始，稍后再看）${quote}`;
  }
  let status: { state?: string; reason?: string; count?: number } = {};
  try {
    status = JSON.parse(readFileSync(statusFile, "utf-8")) as typeof status;
  } catch {
    return `${header}\n  ⚠️ 起草状态文件损坏，需人工检查${quote}`;
  }
  if (status.state === "pending") {
    return `${header}\n  ⏳ 起草中（起草人还在跑），稍后再看${quote}`;
  }
  if (status.state === "failed") {
    return (
      `${header}\n  ⚠️ 起草失败：${status.reason ?? "未知原因"}` +
      `\n  可先驳回，或人工在 candidates/${item.agentId}/${item.caseId}/case.json 里补断言${quote}`
    );
  }
  // ok
  let assertions: ContractAssertion[] = [];
  try {
    const raw = JSON.parse(readFileSync(assertionsFile, "utf-8")) as { assertions?: ContractAssertion[] };
    if (Array.isArray(raw.assertions)) assertions = raw.assertions;
  } catch {
    /* 单文件损坏走空断言分支 */
  }
  if (assertions.length === 0) {
    return (
      `${header}\n  ⚠️ 起草人没产出任何可判断言（信号太弱或反馈太模糊），建议驳回或人工补${quote}`
    );
  }
  const rendered = assertions.map((a) => `    · ${renderDraftAssertion(a)}`).join("\n");
  return `${header}\n  起草断言（${assertions.length} 条，批准后会自动合并）：\n${rendered}${quote}`;
}

function renderDraftAssertion(a: ContractAssertion): string {
  const objective = a.objective ? ` — ${a.objective}` : "";
  if (a.type === "answer_match") {
    const verb = a.negate ? "不含" : "包含";
    return `[${a.id}] 答复必须${verb}正则 /${a.pattern}/i${objective}`;
  }
  if (a.type === "required_call") {
    return `[${a.id}] 必须调用工具 /${a.selector?.toolPattern ?? "?"}/${objective}`;
  }
  return `[${a.id}] ${a.type}${objective}`;
}
