import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import {
  hiredProfileExists,
  loadAgentProfile,
  saveHiredProfile,
  validateAgentProfile,
  type AgentProfile,
} from "../config/agent-profile.js";
import { makeCard, type OutboundCard } from "../channels/card.js";
import {
  checkAttachedEvidence,
  type RegressionEvidence,
} from "../core/regression-gate.js";
import {
  checkAssertionEvidence,
  type AssertionEvidence,
  type AssertionTarget,
} from "../core/assertion-gate.js";
import { ledgerIdsOfProposal, markConsumed, markDeclined, markProposed } from "./temp-ledger.js";

/**
 * 待用户一句话拍板的提案（主管推送 → 「批准/驳回 <提案号>」零 LLM 生效）。
 *
 * 两种：
 * - prompt：提示词优化（优化员产出）。只针对**用户员工**（hired）——他们的提示词在
 *   <userDir>/agents/<id>.json 的 systemPrompt 字段里，改动不进 git、可随时回退。
 *   内置岗位的提示词随代码发布，不走这条自动化通路。
 * - new_hire：由 hr 从临时工台账归纳出的**通用正式岗位**。问的是「这类活已经出现三次了，
 *   要不要设个岗」——而不是「这个临时工留不留」。后者在首个任务刚完成时问，
 *   没有任何证据表明这个能力会再被需要，而且按个体问天然问不出「合并成一个通用岗」。
 */
export interface Proposal {
  id: string;
  /** 缺省 prompt：兼容本字段之前已落盘的提案文件 */
  kind?: "prompt" | "new_hire";
  /** 目标员工（prompt 型必须是 hired 员工；new_hire 型是待创建的新员工 id） */
  agentId: string;
  /** 一句话说清改什么、为什么 */
  summary: string;
  /** 归因证据：runId 列表 */
  evidence: string[];
  /** 改动前后的完整提示词（before 用于回退与冲突检测）。new_hire 型不用 */
  before?: string;
  after?: string;
  /** new_hire 型：待落盘的完整员工配置 */
  profileDraft?: AgentProfile;
  /** new_hire 型：支撑本次建岗的台账记录（批准→consumed，驳回→declined） */
  ledgerIds?: string[];
  /** new_hire 型：覆盖的能力域 slug（闸门自去重用） */
  capabilitySlugs?: string[];
  createdAt: string;
  status: "pending" | "applied" | "rejected";
  decidedAt?: string;
  /** 应用失败/被拒的原因 */
  note?: string;
  /** agent-bench 回归证据（prompt 型）。门禁 enforce 模式下没有通过的证据不许应用 */
  regression?: RegressionEvidence;
  /**
   * 本提案声称要修的断言（prompt 型）。来自 finding 的 caseId + assertionId。
   * 声明了它，门禁才能验证「这条真的修好了」而不是只看某个比率有没有涨。
   */
  targetAssertions?: AssertionTarget[];
  /** 一层回归（确定性断言翻转）证据。零 LLM，是门禁主项 */
  assertionGate?: AssertionEvidence;
}

/** 提案类型（旧文件没有 kind 字段，按 prompt 处理） */
export function proposalKind(p: Proposal): "prompt" | "new_hire" {
  return p.kind ?? "prompt";
}

const PROPOSALS_DIR = join(config.runtimeDir, "proposals");

export function proposalsDir(): string {
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  return PROPOSALS_DIR;
}

function proposalPath(id: string): string {
  return join(PROPOSALS_DIR, `${id}.json`);
}

function readProposal(file: string): Proposal | undefined {
  try {
    const p = JSON.parse(readFileSync(file, "utf-8")) as Proposal;
    return p?.id && p.agentId ? p : undefined;
  } catch {
    return undefined;
  }
}

export function listProposals(status?: Proposal["status"]): Proposal[] {
  if (!existsSync(PROPOSALS_DIR)) return [];
  const out: Proposal[] = [];
  for (const name of readdirSync(PROPOSALS_DIR)) {
    if (!name.endsWith(".json")) continue;
    const p = readProposal(join(PROPOSALS_DIR, name));
    if (p && (!status || p.status === status)) out.push(p);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getProposal(id: string): Proposal | undefined {
  const file = proposalPath(id);
  return existsSync(file) ? readProposal(file) : undefined;
}

function save(p: Proposal): void {
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  writeFileSync(proposalPath(p.id), `${JSON.stringify(p, null, 2)}\n`, "utf-8");
}

/**
 * 应用一条提案。
 * - prompt：把 after 写回该员工 profile 的 systemPrompt（带冲突保护）
 * - new_hire：落盘一位新的正式员工，并把支撑它的台账记录标为已消费
 */
export function applyProposal(id: string): { ok: boolean; message: string; agentId?: string } {
  const p = getProposal(id);
  if (!p) return { ok: false, message: `没有找到提案 ${id}` };
  if (p.status !== "pending") return { ok: false, message: `提案 ${id} 已经是 ${p.status} 状态` };
  if (proposalKind(p) === "new_hire") return applyNewHire(p);
  if (!hiredProfileExists(p.agentId)) {
    return { ok: false, message: `员工 ${p.agentId} 不存在或不是用户员工，拒绝应用` };
  }
  const profile = loadAgentProfile(p.agentId);
  if (!profile) return { ok: false, message: `读不到员工 ${p.agentId} 的配置` };
  if (profile.promptFrozen) {
    // 裁判的提示词若可被优化师改写，「被优化者与裁判同源」就退化成
    // 自己给自己发合格证。这不是补跑回归能解决的问题，直接作废。
    p.status = "rejected";
    p.decidedAt = new Date().toISOString();
    p.note = "该岗位提示词已冻结（promptFrozen），不接受优化提案";
    save(p);
    return { ok: false, message: `提案 ${id} 已作废：${p.agentId} 的提示词已冻结，不接受优化提案` };
  }
  if ((profile.systemPrompt ?? "") !== (p.before ?? "")) {
    p.status = "rejected";
    p.decidedAt = new Date().toISOString();
    p.note = "提示词在提案生成后被改动过，为避免覆盖已作废";
    save(p);
    return {
      ok: false,
      message: `提案 ${id} 已作废：${p.agentId} 的提示词在这期间被改过，请让优化员基于最新版本重新分析`,
    };
  }
  try {
    const gateMode = config.gate.mode;
    if (gateMode !== "off") {
      // 一层（确定性断言翻转）是门禁主项：零 LLM、判的是因果。
      // 只在提案声明了 targetAssertions 或已附一层证据时生效——
      // 没声明也没证据的旧提案仍走二层判据，不因为新增门禁而全部作废。
      if (p.targetAssertions?.length || p.assertionGate) {
        const tier1 = checkAssertionEvidence(p.assertionGate, p.after ?? "");
        if (!tier1.allow && gateMode === "enforce") {
          p.note = `一层回归门禁拦截：${tier1.reason}`;
          save(p);
          return {
            ok: false,
            message: `提案 ${id} 未通过一层回归门禁：${tier1.reason}。跑 foreman gate stage/attach 补齐证据后再批准`,
          };
        }
        if (!tier1.allow) console.warn(`[gate] warn 模式放行提案 ${id}（一层）：${tier1.reason}`);
      }
      const gate = checkAttachedEvidence(p.regression, p.after ?? "");
      if (!gate.allow && gateMode === "enforce") {
        // 保持 pending：补跑回归后可以直接重试，不必让优化员重新分析
        p.note = `回归门禁拦截：${gate.reason}`;
        save(p);
        return {
          ok: false,
          message: `提案 ${id} 未通过回归门禁：${gate.reason}。补跑 agent-bench 回归并附上结果后再批准，或把 gate.mode 调成 warn 临时放行`,
        };
      }
      if (!gate.allow) {
        console.warn(`[gate] warn 模式放行提案 ${id}：${gate.reason}`);
      }
    }
    saveHiredProfile({ ...profile, systemPrompt: p.after ?? "" });
  } catch (error) {
    return {
      ok: false,
      message: `写入失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  p.status = "applied";
  p.decidedAt = new Date().toISOString();
  save(p);
  return { ok: true, message: `已应用到「${p.agentId}」：${p.summary}`, agentId: p.agentId };
}

/**
 * 建岗：落盘一位**新 id 的**正式员工。
 *
 * 不继承任何一个临时工的 id——这个岗位是多个临时工的合并，凭什么用其中某一个的身份？
 * （他们的目录在释放时就清了，也没有「孤立目录」的顾虑。）
 */
function applyNewHire(p: Proposal): { ok: boolean; message: string; agentId?: string } {
  const draft = p.profileDraft;
  if (!draft) {
    p.status = "rejected";
    p.decidedAt = new Date().toISOString();
    p.note = "提案缺少 profileDraft，无法落盘";
    save(p);
    return { ok: false, message: `提案 ${p.id} 没带员工配置草案，落不了盘。让 hr 重新出一条。` };
  }
  if (hiredProfileExists(draft.id)) {
    return { ok: false, message: `员工 id「${draft.id}」已存在，让 hr 换个 id 重出一条提案` };
  }
  const errs = validateAgentProfile(draft, true);
  if (errs.length > 0) {
    return { ok: false, message: `员工配置不合规，没落盘：${errs.join("; ")}` };
  }
  try {
    saveHiredProfile({ ...draft, createdAt: new Date().toISOString(), createdBy: "hr" });
  } catch (error) {
    return {
      ok: false,
      message: `建岗失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // 证据已经变成正式岗位，可以退场了（连同归档 spec 由剪枝顺带清理）
  markConsumed(p.ledgerIds ?? ledgerIdsOfProposal(p.id));
  p.status = "applied";
  p.decidedAt = new Date().toISOString();
  save(p);
  return {
    ok: true,
    message:
      `已设立新岗位「${draft.displayName ?? draft.id}」（${draft.id}）✅ 从下一条消息起就能自动派活给他。\n` +
      `这类活之前是临时工反复在接，现在有固定的人了。`,
    agentId: draft.id,
  };
}

export function rejectProposal(id: string, note?: string): { ok: boolean; message: string } {
  const p = getProposal(id);
  if (!p) return { ok: false, message: `没有找到提案 ${id}` };
  if (p.status !== "pending") return { ok: false, message: `提案 ${id} 已经是 ${p.status} 状态` };
  p.status = "rejected";
  p.decidedAt = new Date().toISOString();
  if (note) p.note = note;
  save(p);
  if (proposalKind(p) === "new_hire") {
    // 标 declined 而不是删：不能拿同一批记录反复烦用户，但证据得留着
    markDeclined(p.ledgerIds ?? ledgerIdsOfProposal(p.id));
  }
  return { ok: true, message: `已驳回提案 ${id}（${p.agentId}）` };
}

/** 回退：把某条已应用的提案还原成 before（误批准时的补救） */
export function revertProposal(id: string): { ok: boolean; message: string } {
  const p = getProposal(id);
  if (!p) return { ok: false, message: `没有找到提案 ${id}` };
  if (proposalKind(p) === "new_hire") {
    return { ok: false, message: `${id} 是建岗提案，没有「回退」这回事——要让他走就说「删掉员工 ${p.agentId}」` };
  }
  if (p.status !== "applied") return { ok: false, message: `提案 ${id} 未处于已应用状态` };
  const profile = loadAgentProfile(p.agentId);
  if (!profile) return { ok: false, message: `读不到员工 ${p.agentId} 的配置` };
  try {
    saveHiredProfile({ ...profile, systemPrompt: p.before ?? "" });
  } catch (error) {
    return {
      ok: false,
      message: `回退失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  p.status = "rejected";
  p.decidedAt = new Date().toISOString();
  p.note = "已回退到提案前的版本";
  save(p);
  return { ok: true, message: `已把「${p.agentId}」的提示词回退到提案前的版本` };
}

/**
 * 回归门禁的测量通路（stage → 跑回归 → attach）。
 *
 * 为什么需要它：门禁读 `p.regression`，但候选提示词没法在「不生效」的前提下被测量——
 * 这也正是 runtimeState 判据存在的理由（提示词没真的换过，那份成绩就不是候选的成绩）。
 * 所以先把候选临时挂上去跑回归，回填证据时再摘下来，期间提案状态始终是 pending。
 */
function promptProposalForMeasure(id: string): { p?: Proposal; message?: string } {
  const p = getProposal(id);
  if (!p) return { message: `没有找到提案 ${id}` };
  if (proposalKind(p) !== "prompt") return { message: `提案 ${id} 不是提示词型，没有回归可跑` };
  if (p.status !== "pending") return { message: `提案 ${id} 已经是 ${p.status} 状态` };
  if (!hiredProfileExists(p.agentId)) {
    return { message: `员工 ${p.agentId} 不存在或不是用户员工` };
  }
  // 不拒的话可以先把候选挂到评测师身上跑回归，等于绕过 applyProposal 那道拒绝
  if (loadAgentProfile(p.agentId)?.promptFrozen) {
    return { message: `${p.agentId} 的提示词已冻结（promptFrozen），不接受优化提案` };
  }
  return { p };
}

/** 把候选提示词临时写进员工 profile，让回归跑的是真的候选（runtimeState 会随之变化） */
export function stageCandidatePrompt(id: string): { ok: boolean; message: string; agentId?: string } {
  const { p, message } = promptProposalForMeasure(id);
  if (!p) return { ok: false, message: message ?? "" };
  const profile = loadAgentProfile(p.agentId);
  if (!profile) return { ok: false, message: `读不到员工 ${p.agentId} 的配置` };
  const current = profile.systemPrompt ?? "";
  if (current === (p.after ?? "")) {
    return { ok: true, message: `候选提示词已经挂着了（${p.agentId}），可以直接跑回归`, agentId: p.agentId };
  }
  if (current !== (p.before ?? "")) {
    return {
      ok: false,
      message: `${p.agentId} 当前的提示词既不是提案的 before 也不是 after，期间被人改过——不要在这个状态上跑回归，先让优化员基于最新版本重新分析`,
    };
  }
  try {
    saveHiredProfile({ ...profile, systemPrompt: p.after ?? "" });
  } catch (error) {
    return {
      ok: false,
      message: `挂载候选失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, message: `已把候选提示词挂到「${p.agentId}」，跑完回归记得 attach（会自动摘下）`, agentId: p.agentId };
}

/** 摘下候选、还原成 before */
export function unstageCandidatePrompt(id: string): { ok: boolean; message: string } {
  const { p, message } = promptProposalForMeasure(id);
  if (!p) return { ok: false, message: message ?? "" };
  const profile = loadAgentProfile(p.agentId);
  if (!profile) return { ok: false, message: `读不到员工 ${p.agentId} 的配置` };
  const current = profile.systemPrompt ?? "";
  if (current === (p.before ?? "")) {
    return { ok: true, message: `「${p.agentId}」已经是提案前的版本，无需还原` };
  }
  if (current !== (p.after ?? "")) {
    // 期间有人改过：还原就是覆盖别人的改动，宁可停下来报清楚
    return {
      ok: false,
      message: `${p.agentId} 当前的提示词不是本提案挂上去的候选，拒绝还原（避免覆盖别人的改动）`,
    };
  }
  try {
    saveHiredProfile({ ...profile, systemPrompt: p.before ?? "" });
  } catch (error) {
    return {
      ok: false,
      message: `还原失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, message: `已把「${p.agentId}」还原成提案前的版本` };
}

/** 回填回归证据。证据本身带 promptSha，应用时会再校验一次是否张冠李戴 */
export function attachRegressionEvidence(
  id: string,
  evidence: RegressionEvidence,
): { ok: boolean; message: string } {
  const { p, message } = promptProposalForMeasure(id);
  if (!p) return { ok: false, message: message ?? "" };
  p.regression = evidence;
  save(p);
  return { ok: true, message: `已把回归证据附到提案 ${id}（${evidence.status}）` };
}

/** 回填一层（断言翻转）证据。同样带 promptSha，应用时再校验一次绑定关系 */
export function attachAssertionEvidence(
  id: string,
  evidence: AssertionEvidence,
): { ok: boolean; message: string } {
  const { p, message } = promptProposalForMeasure(id);
  if (!p) return { ok: false, message: message ?? "" };
  p.assertionGate = evidence;
  save(p);
  return { ok: true, message: `已把一层回归证据附到提案 ${id}（${evidence.status}）` };
}

/** 已有待审提案的员工：优化员应跳过他们，避免同一员工堆多条 pending（批准一条会让其余作废） */
export function agentsWithPendingProposal(): string[] {
  return [...new Set(listProposals("pending").map((p) => p.agentId))];
}

/** 待审提案摘要（boss 播报 / 状态板用） */
export function pendingProposalsBrief(): string | undefined {
  const pending = listProposals("pending");
  if (pending.length === 0) return undefined;
  const lines = pending.map((p) => {
    const tag = proposalKind(p) === "new_hire" ? "建岗" : "改提示词";
    return `- \`${p.id}\`（${tag}·${p.agentId}）：${p.summary}${p.evidence.length ? ` ｜证据 ${p.evidence.length} 条` : ""}`;
  });
  return [
    `📋 有 ${pending.length} 条待你拍板的提案：`,
    ...lines,
    "",
    "回「批准 <提案号>」通过，「驳回 <提案号>」不通过；改提示词那类批准后若效果不好可以说「回退 <提案号>」。",
  ].join("\n");
}

/**
 * 建一条「设立通用岗位」提案（hr 归纳产出）。
 *
 * 时机由代码闸门决定：同一能力域的临时工记录攒够阈值才叫 hr（见 scheduler.scan）。
 * 走提案而不是当场落盘：新增一个会自动接活的同事，必须由用户拍板。
 */
export function createNewHireProposal(input: {
  profileDraft: AgentProfile;
  /** 支撑本次建岗的台账记录 */
  ledgerIds: string[];
  capabilitySlugs: string[];
  /** 一句话说清为什么该设这个岗 */
  summary: string;
  /** 引用的任务号，供用户核对 */
  evidence?: string[];
}): Proposal {
  const p: Proposal = {
    id: `hire-${input.profileDraft.id}-${Date.now().toString(36)}`,
    kind: "new_hire",
    agentId: input.profileDraft.id,
    summary: input.summary,
    evidence: input.evidence ?? [],
    profileDraft: input.profileDraft,
    ledgerIds: input.ledgerIds,
    capabilitySlugs: input.capabilitySlugs,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  save(p);
  markProposed(input.ledgerIds, p.id);
  return p;
}

/** 已有待审建岗提案覆盖的能力域（闸门自去重：同一能力域不重复叫 hr） */
export function pendingNewHireSlugs(): Set<string> {
  const out = new Set<string>();
  for (const p of listProposals("pending")) {
    if (proposalKind(p) !== "new_hire") continue;
    for (const slug of p.capabilitySlugs ?? []) out.add(slug);
  }
  return out;
}

/**
 * 待审提案的答题卡：**只有恰好一条**待审时才给按钮。
 * 多条时两个按钮说不清指向哪一条，回落纯文本（brief 里每条都带提案号，用户打字指名）。
 * 按钮回填的是 boss 的确定性命令文本，点完零 LLM 直接生效。
 */
export function pendingProposalsCard(): OutboundCard | undefined {
  const pending = listProposals("pending");
  if (pending.length !== 1) return undefined;
  const p = pending[0];
  if (proposalKind(p) === "new_hire") {
    const draft = p.profileDraft;
    return makeCard(
      `建岗提案：${draft?.displayName ?? p.agentId}`,
      [
        `这类活已经由临时工接了 ${p.ledgerIds?.length ?? 0} 次，建议设一个固定岗位：`,
        p.summary,
        draft?.routeHint ? `\n职责边界：${draft.routeHint.slice(0, 300)}` : "",
        p.evidence.length ? `\n证据任务：${p.evidence.map((e) => `#${e}`).join("、")}` : "",
        "",
        `提案号 \`${p.id}\`。批准后他会正式进团队名册、开始积累经验。`,
      ]
        .filter(Boolean)
        .join("\n"),
      [
        { title: "设立这个岗位", reply: `批准 ${p.id}` },
        { title: "不用", reply: `驳回 ${p.id}` },
      ],
    );
  }
  return makeCard(
    `优化提案待审：${p.agentId}`,
    [
      `优化员建议改一下「${p.agentId}」的提示词：`,
      p.summary,
      p.evidence.length ? `归因证据 ${p.evidence.length} 条。` : "",
      "",
      `提案号 \`${p.id}\`。批准后若效果不好，说「回退 ${p.id}」可还原。`,
    ]
      .filter(Boolean)
      .join("\n"),
    [
      { title: "批准应用", reply: `批准 ${p.id}` },
      { title: "驳回", reply: `驳回 ${p.id}` },
    ],
  );
}
