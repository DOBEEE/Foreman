import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { config } from "../config/index.js";
import { getAgent } from "../agents/registry.js";
import { collectRun } from "../core/runner.js";
import { harvestRoots } from "../core/case-harvest.js";
import { extractJson } from "./judge-contract.js";
import { ensureDir, writeJson } from "./files.js";
import { consecutivePasses } from "./history.js";
import type { RegressionCase, RegressionCaseResult } from "./regression.js";

/**
 * 一层 case → 二层 case 的升级。
 *
 * 二层比一层多两样制品：冻结事实（幻觉率的事实源）与规约清单（规约遵从率的判据）。
 * 它们不能自动落地就完事，因为一份错的事实源会把**正确**的答复判成幻觉——
 * 比没有事实源更坏。所以流程是「机器起草 + 机器校验 + 人一次确认」。
 *
 * 三段职责划得很死：
 *   - **规约候选来自轨迹**：那次执行实际 Read 了哪些知识库文件是客观事实，
 *     比让模型"猜哪些规约相关"可靠
 *   - **事实由命题人起草**：不能是优化师（被这把尺子量的那个）、也不能是评测师
 *     （自己出题自己判，且模糊的题让它的判定无法被证伪）
 *   - **引文由代码校验**：逐字比对，对不上整条丢弃。最危险的失效形态是编造引文，
 *     这一条机器抓，人只需要判断"这几句是不是重点"
 */

/** 二层探针的目标条数。二层答的是「整体变笨了吗」，要的是稳定探针而非覆盖率 */
const QUALITY_CASE_TARGET = 3;
/** 连续全绿几轮才够稳当探针 */
const STABILITY_THRESHOLD = 3;

export interface DraftedFact {
  id: string;
  statement: string;
  evidence: Array<{ document: string; quote: string }>;
}

export interface DraftedConvention {
  id: string;
  document: string;
  requirement: string;
  quote: string;
}

export interface PendingUpgrade {
  schemaVersion: 1;
  kind: "quality_upgrade";
  agentId: string;
  caseId: string;
  prompt: string;
  facts: DraftedFact[];
  conventions: DraftedConvention[];
  /** 引文校验时被丢弃的条目，人要能看到「机器替我拦掉了什么」 */
  rejected: Array<{ id: string; document: string; reason: string }>;
  notes?: string;
  draftedAt: string;
}

function upgradesDir(): string {
  return join(harvestRoots().root, "upgrades");
}

export function upgradeFile(agentId: string, caseId: string): string {
  return join(upgradesDir(), agentId, `${caseId}.json`);
}

/** 已有二层制品的 case 数（requirements.json 在就算） */
export function qualityCaseCount(agentId: string): number {
  const root = join(harvestRoots().cases, agentId);
  if (!existsSync(root)) return 0;
  return readdirSync(root).filter((caseId) =>
    existsSync(join(root, caseId, "oracle", "requirements.json")),
  ).length;
}

export function listPendingUpgrades(agentId?: string): PendingUpgrade[] {
  const root = upgradesDir();
  if (!existsSync(root)) return [];
  const agents = agentId ? [agentId] : readdirSync(root);
  const out: PendingUpgrade[] = [];
  for (const agent of agents) {
    const dir = join(root, agent);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(dir, name), "utf-8")) as PendingUpgrade);
      } catch {
        // 半个草稿跳过
      }
    }
  }
  return out;
}

/** 内容层断言：清一色 CONTRACT-* 的纯边界 case 提上去也没内容可判，白花钱 */
function hasContentAssertion(benchmarkCase: RegressionCase): boolean {
  return benchmarkCase.assertions.some(
    (item) => !item.id.startsWith("CONTRACT-") || item.type === "answer_match",
  );
}

export type UpgradeDecision =
  | { eligible: false; reason: string }
  | { eligible: true };

/**
 * 判一条 case 现在该不该升。
 *
 * 三条同时满足。刻意不把「时间够久」当条件——挂了三个月却从没被跑过的 case
 * 并不比昨天新增的更可靠，稳定性只能由实际跑过的轮次说话。
 */
export function upgradeDecision(params: {
  benchmarkCase: RegressionCase;
  result?: RegressionCaseResult;
}): UpgradeDecision {
  const { benchmarkCase, result } = params;
  const caseRoot = benchmarkCase.root;
  if (existsSync(join(caseRoot, "oracle", "requirements.json"))) {
    return { eligible: false, reason: "已经是二层 case" };
  }
  if (existsSync(upgradeFile(benchmarkCase.agentId, benchmarkCase.caseId))) {
    return { eligible: false, reason: "已有待审的升级草稿" };
  }
  if (qualityCaseCount(benchmarkCase.agentId) >= QUALITY_CASE_TARGET) {
    return {
      eligible: false,
      reason: `${benchmarkCase.agentId} 已有 ${QUALITY_CASE_TARGET} 条二层 case，够用了（二层要探针不要覆盖率）`,
    };
  }
  if (!hasContentAssertion(benchmarkCase)) {
    return { eligible: false, reason: "断言清一色是工具边界，没有内容层可判" };
  }
  if (result && result.status !== "passed") {
    return { eligible: false, reason: "本轮没通过，先修好再谈升级" };
  }
  const passes = consecutivePasses(benchmarkCase.caseId);
  if (passes < STABILITY_THRESHOLD) {
    return {
      eligible: false,
      reason: `只连续全绿 ${passes} 轮（需 ≥${STABILITY_THRESHOLD}）—— 不稳的 case 当探针，分数动了没法归因`,
    };
  }
  return { eligible: true };
}

/**
 * 从轨迹里取出这次执行实际读过的知识库文件（相对路径）。
 *
 * 用真实读过的文件而不是让模型猜，是因为前者是客观事实。代价是那次执行本身
 * 可能就漏读了该读的东西，所以命题人被允许在知识库内自行 Grep 补齐。
 */
export function knowledgeFilesFromTrace(transcriptFile: string): string[] {
  if (!existsSync(transcriptFile)) return [];
  const root = resolve(config.knowledgeDir);
  const found = new Set<string>();
  for (const line of readFileSync(transcriptFile, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { tool?: { input?: Record<string, unknown> } };
      const input = record.tool?.input;
      if (!input) continue;
      for (const key of ["file_path", "path"]) {
        const value = input[key];
        if (typeof value !== "string" || !value) continue;
        const rel = relative(root, resolve(value));
        if (!rel.startsWith("..") && rel !== "") found.add(rel);
      }
    } catch {
      // 文本行不含工具入参
    }
  }
  return [...found].sort();
}

/**
 * 逐字校验引文。
 *
 * 这是整条自动化里最关键的一道确定性关卡：模型编造引文是**必然会发生**的，
 * 而编造的引文会让正确答复被判成幻觉。校验只做一件事——这段话在不在那个文件里。
 *
 * 归一化只做空白折叠：文件里换行/缩进与模型复制出来的往往不同，但**不做**大小写、
 * 标点或同义归一。放宽到那个程度就等于承认「差不多就算」，而事实源不能差不多。
 */
/**
 * 引文的最小信息量。
 *
 * 这条守卫真正要保证的不是「够长」，而是**引文本身能当证据被人读懂**。
 * 因为人确认的是事实陈述，他默认引文会把依据显示出来；如果引文短到只是个词
 * （「阈值」），一条编造的「阈值是 50」也能拿到"引文命中"，人的那道确认就被架空了。
 *
 * 所以按字形加权而不是数字符：8 个汉字是一个完整分句，8 个拉丁字母只是一个单词。
 * 一刀切会把合法的中文引文全判掉（实测「小库全量注入」6 字直接被拒）。
 */
const QUOTE_MIN_WEIGHT = 15;

/**
 * 中日韩字形范围。
 *
 * **必须含标点与全角形式**（`\u3000-\u303f` 的 。、「」 与 `\uff00-\uffef` 的 ，：！？）：
 * 中文换行最常发生在标点之后，「…全量注入，\n大库…」里换行前那个字符是全角逗号，
 * 不含它就识别不到这是 CJK 换行，跨行引文照样对不上（实测栽在这一条）。
 */
const CJK =
  "\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af\\uff00-\\uffef";
const CJK_RE = new RegExp(`[${CJK}]`);
/** 夹在两个 CJK 字符之间的空白：源文件里的换行，不是真的空格 */
const CJK_GAP_RE = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, "g");

/**
 * 引文归一化。
 *
 * 只做空白处理，**不做**大小写、标点或同义归一 —— 放宽到那个程度就等于承认
 * 「差不多就算」，而事实源不能差不多。
 *
 * 但空白处理必须分语种：把换行折叠成空格对拉丁文是对的（词之间本来有空格），
 * 对中日韩是错的。源文件里「小库全量注入，\n大库只给索引」换行处并没有空格，
 * 模型跨行复制出来也不会带空格，一律折叠成空格就永远对不上（实测撞到这一条）。
 */
function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, " ").replace(CJK_GAP_RE, "").trim();
}

function quoteWeight(text: string): number {
  let weight = 0;
  for (const char of text) {
    weight += CJK_RE.test(char) ? 3 : 1;
  }
  return weight;
}

export function quoteExists(knowledgeRoot: string, document: string, quote: string): boolean {
  const file = join(knowledgeRoot, document);
  // document 必须落在知识库内：模型给出 ../../.env 这类路径时不能去读
  if (relative(knowledgeRoot, file).startsWith("..")) return false;
  if (!existsSync(file)) return false;
  const needle = normalizeQuote(quote);
  if (quoteWeight(needle) < QUOTE_MIN_WEIGHT) return false;
  return normalizeQuote(readFileSync(file, "utf-8")).includes(needle);
}

function verify(draft: {
  facts?: DraftedFact[];
  conventions?: DraftedConvention[];
  notes?: string;
}): Pick<PendingUpgrade, "facts" | "conventions" | "rejected"> {
  const knowledgeRoot = resolve(config.knowledgeDir);
  const rejected: PendingUpgrade["rejected"] = [];

  const facts: DraftedFact[] = [];
  for (const fact of draft.facts ?? []) {
    const good = (fact.evidence ?? []).filter((item) =>
      quoteExists(knowledgeRoot, item.document, item.quote),
    );
    if (!good.length) {
      // 一条引文都对不上 = 这条"事实"是模型推断出来的，整条丢弃
      rejected.push({
        id: fact.id,
        document: fact.evidence?.[0]?.document ?? "?",
        reason: "所有引文都无法在源文件里逐字命中",
      });
      continue;
    }
    facts.push({ ...fact, evidence: good });
  }

  const conventions: DraftedConvention[] = [];
  for (const rule of draft.conventions ?? []) {
    if (!quoteExists(knowledgeRoot, rule.document, rule.quote)) {
      rejected.push({ id: rule.id, document: rule.document, reason: "引文无法逐字命中" });
      continue;
    }
    conventions.push(rule);
  }

  return { facts, conventions, rejected };
}

export type DraftOutcome =
  | { ok: false; reason: string }
  | { ok: true; upgrade: PendingUpgrade; file: string };

/** 让命题人起草，校验后落成待审升级 */
export async function draftQualityUpgrade(params: {
  benchmarkCase: RegressionCase;
  transcriptFile: string;
}): Promise<DraftOutcome> {
  const { benchmarkCase, transcriptFile } = params;
  const agent = getAgent("oracle");
  if (!agent) return { ok: false, reason: "命题人岗位 oracle 未注册" };

  const knowledgeFiles = knowledgeFilesFromTrace(transcriptFile);
  const collected = await collectRun(
    agent.run({
      prompt:
        "为下面这条回归用例起草冻结事实与逐字引文。只返回 JSON。\n\n" +
        `用例 id：${benchmarkCase.caseId}\n岗位：${benchmarkCase.agentId}`,
      // 命题人不注入经验库：事实源必须只来自知识库原文，
      // 让它带着「上次怎么出题的」进来会让口径慢慢漂
      memory: "off",
      params: {
        channel: "bench",
        chatType: "private",
        senderName: "bench",
        agentId: benchmarkCase.agentId,
        casePrompt: benchmarkCase.prompt,
        knowledgeRoot: config.knowledgeDir,
        knowledgeFiles: knowledgeFiles.length
          ? knowledgeFiles.map((f) => `- \`${f}\``).join("\n")
          : "（那次执行没读过任何知识库文件——你需要自己在知识库里找相关文件）",
      },
    }),
  );
  if (collected.summary?.isError) {
    return { ok: false, reason: `命题人执行失败：${String(collected.summary.result ?? "").slice(0, 300)}` };
  }

  let draft;
  try {
    draft = extractJson(collected.text) as {
      facts?: DraftedFact[];
      conventions?: DraftedConvention[];
      notes?: string;
    };
  } catch (error) {
    return { ok: false, reason: `命题人产出不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }

  const verified = verify(draft);
  if (!verified.facts.length) {
    // 一条都没过校验：不落草稿。摆一个空事实源给人看只会浪费一次确认
    return {
      ok: false,
      reason: `没有任何事实通过引文校验（丢弃 ${verified.rejected.length} 条），不产草稿`,
    };
  }

  const upgrade: PendingUpgrade = {
    schemaVersion: 1,
    kind: "quality_upgrade",
    agentId: benchmarkCase.agentId,
    caseId: benchmarkCase.caseId,
    prompt: benchmarkCase.prompt,
    ...verified,
    ...(draft.notes ? { notes: draft.notes } : {}),
    draftedAt: new Date().toISOString(),
  };
  const file = upgradeFile(benchmarkCase.agentId, benchmarkCase.caseId);
  ensureDir(join(file, ".."));
  writeJson(file, upgrade);
  return { ok: true, upgrade, file };
}

/**
 * 批准一条升级：把制品写进 case 目录，这条 case 从此参与二层评测。
 *
 * conventions 里的 document 是相对知识库的路径，`evidence.ts` 会用 knowledgeRoot
 * 拼回去读正文——所以这里存相对路径而不是绝对路径，换台机器仍然能用。
 */
export function approveQualityUpgrade(agentId: string, caseId: string): { ok: boolean; message: string } {
  const file = upgradeFile(agentId, caseId);
  if (!existsSync(file)) return { ok: false, message: `没有待审升级 ${agentId}/${caseId}` };
  const upgrade = JSON.parse(readFileSync(file, "utf-8")) as PendingUpgrade;
  const caseRoot = join(harvestRoots().cases, agentId, caseId);
  if (!existsSync(caseRoot)) return { ok: false, message: `case ${agentId}/${caseId} 不在套件里了` };

  writeJson(join(caseRoot, "oracle", "requirements.json"), {
    schemaVersion: 1,
    facts: upgrade.facts,
    approvedAt: new Date().toISOString(),
  });
  if (upgrade.conventions.length) {
    writeJson(join(caseRoot, "conventions-ref.json"), {
      schemaVersion: 1,
      knowledge: { source: "agent-base-local" },
      items: upgrade.conventions.map((rule) => ({
        id: rule.id,
        document: rule.document,
        requirement: rule.requirement,
        quote: rule.quote,
      })),
    });
  }
  rmSync(file, { force: true });
  return {
    ok: true,
    message:
      `已升级 ${agentId}/${caseId} 为二层用例（${upgrade.facts.length} 条事实` +
      `${upgrade.conventions.length ? `、${upgrade.conventions.length} 条规约` : ""}）` +
      `\n它进 caseSet 指纹，现有二层基线需重新 promote`,
  };
}

export function discardQualityUpgrade(agentId: string, caseId: string): { ok: boolean; message: string } {
  const file = upgradeFile(agentId, caseId);
  if (!existsSync(file)) return { ok: false, message: `没有待审升级 ${agentId}/${caseId}` };
  rmSync(file, { force: true });
  // 不做永久黑名单：下轮这条 case 若仍稳定，还会重新起草。
  // 一次草稿写得不好，不该让这条 case 永远无法进二层。
  return { ok: true, message: `已丢弃 ${agentId}/${caseId} 的升级草稿（下轮会重新起草）` };
}

/** 待审升级的文本摘要，供渠道推送 */
export function pendingUpgradesBrief(): string | undefined {
  const pending = listPendingUpgrades();
  if (!pending.length) return undefined;
  const blocks = pending.map((item) => {
    const facts = item.facts
      .map((f) => `    - ${f.statement}\n      引自 \`${f.evidence[0].document}\``)
      .join("\n");
    const rules = item.conventions.length
      ? `\n  规约：\n${item.conventions.map((r) => `    - ${r.requirement}（\`${r.document}\`）`).join("\n")}`
      : "";
    const dropped = item.rejected.length ? `\n  机器已拦掉 ${item.rejected.length} 条引文对不上的` : "";
    const notes = item.notes ? `\n  命题人备注：${item.notes}` : "";
    return `- \`${item.caseId}\`（${item.agentId}）\n  事实：\n${facts}${rules}${dropped}${notes}`;
  });
  return (
    `有 ${pending.length} 条用例可升级为二层（能测「是不是变笨了」）。` +
    `下面每条引文都已逐字核验过，你只需要判断**这几句是不是这个场景的重点**：\n\n` +
    `${blocks.join("\n\n")}\n\n` +
    `回「批准用例 <id>」收下，或「驳回用例 <id>」丢弃。`
  );
}
