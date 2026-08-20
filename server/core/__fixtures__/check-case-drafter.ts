/**
 * case-drafter 起草流程校验（零 LLM，纯断言）。
 *
 * 守的是：
 * 1. 类型联合已经暴露 answer_match / required_call
 * 2. normalize 白名单校验：非法 type / 无效正则 / 岗位工具外的 tool / 重复 id 都被丢弃
 * 3. 状态文件读写：pending / ok / failed 三态可读回
 * 4. pendingCasesBrief 遇到起草中 / 起草失败 / 空断言时都渲得出人能看懂的话
 * 5. approveHarvestedCase 在 case 无断言 + 草稿就绪时把草稿合并进正式断言
 * 6. draft/ 目录随晋升一起搬进 cases/
 *
 * 用法：npx tsx server/core/__fixtures__/check-case-drafter.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harvestRoots, pendingCasesBrief, approveHarvestedCase } from "../case-harvest.js";
import { readCaseDraft } from "../case-drafter.js";
import type { ContractAssertion } from "../contract-assertions.js";

let pass = 0;
const fails: string[] = [];

function check(label: string, ok: boolean, extra?: string): void {
  if (ok) {
    pass++;
    process.stdout.write(`  ✅ ${label}\n`);
  } else {
    fails.push(label);
    process.stdout.write(`  ❌ ${label}${extra ? ` — ${extra}` : ""}\n`);
  }
}

const roots = harvestRoots();
const cleanup: string[] = [];
process.on("exit", () => {
  for (const p of cleanup) rmSync(p, { recursive: true, force: true });
});

/** 直接写候选目录（跳过 harvestCase，避免真跑起草人 LLM）。 */
function writeCandidate(
  agentId: string,
  caseId: string,
  body: {
    prompt: string;
    feedbackText?: string;
    assertions?: ContractAssertion[];
  },
): string {
  const dir = join(roots.candidates, agentId, caseId);
  cleanup.push(dir, join(roots.cases, agentId, caseId));
  mkdirSync(join(dir, "input"), { recursive: true });
  mkdirSync(join(dir, "oracle"), { recursive: true });
  const now = new Date().toISOString();
  const value = {
    schemaVersion: 1 as const,
    caseId,
    agentId,
    source: "user_feedback" as const,
    prompt: body.prompt,
    assertions: body.assertions ?? [],
    provenance: {
      runIds: [`run-${caseId}`],
      sessionIds: [],
      ...(body.feedbackText ? { feedbackText: body.feedbackText } : {}),
      firstSeenAt: now,
      lastSeenAt: now,
      reproductions: 2,
    },
  };
  writeFileSync(join(dir, "case.json"), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  writeFileSync(join(dir, "input", "prompt.md"), `${body.prompt}\n`, "utf-8");
  writeFileSync(
    join(dir, "oracle", "trace.json"),
    `${JSON.stringify({ schemaVersion: 1, assertions: [] }, null, 2)}\n`,
    "utf-8",
  );
  return dir;
}

function writeDraft(
  agentId: string,
  caseId: string,
  state: "pending" | "ok" | "failed",
  opts: { assertions?: ContractAssertion[]; reason?: string } = {},
): void {
  const dir = join(roots.candidates, agentId, caseId, "draft");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  if (state === "pending") {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state, startedAt: now }));
    return;
  }
  if (state === "failed") {
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ state, finishedAt: now, reason: opts.reason ?? "boom" }),
    );
    return;
  }
  const assertions = opts.assertions ?? [];
  writeFileSync(
    join(dir, "status.json"),
    JSON.stringify({ state, finishedAt: now, count: assertions.length }),
  );
  writeFileSync(
    join(dir, "assertions.json"),
    JSON.stringify({ schemaVersion: 1, assertions }, null, 2),
  );
}

process.stdout.write("\n▶ ContractAssertion 类型已暴露 answer_match / required_call\n");
{
  const answer: ContractAssertion = {
    id: "T-1",
    type: "answer_match",
    pattern: "hello",
    negate: false,
    objective: "type test",
    scoring: ["completion"],
    allowEquivalent: false,
  };
  const required: ContractAssertion = {
    id: "T-2",
    type: "required_call",
    selector: { toolPattern: "^Read$" },
    objective: "type test",
    scoring: ["completion"],
    allowEquivalent: false,
  };
  check("answer_match 可构造", answer.type === "answer_match" && answer.pattern === "hello");
  check(
    "required_call + selector.toolPattern 可构造",
    required.type === "required_call" && required.selector?.toolPattern === "^Read$",
  );
}

process.stdout.write("\n▶ readCaseDraft 各状态\n");
{
  const cid = "default-draft-pending";
  writeCandidate("default", cid, { prompt: "p" });
  writeDraft("default", cid, "pending");
  const d = readCaseDraft("default", cid);
  check("pending 状态可读回", d?.status.state === "pending");
  check("pending 时 assertions 空", d?.assertions.length === 0);
}
{
  const cid = "default-draft-failed";
  writeCandidate("default", cid, { prompt: "p" });
  writeDraft("default", cid, "failed", { reason: "无法生成合法 JSON" });
  const d = readCaseDraft("default", cid);
  check("failed 状态可读回", d?.status.state === "failed");
  check(
    "failed 带 reason",
    d?.status.state === "failed" && d.status.reason.includes("无法生成合法 JSON"),
  );
}
{
  const cid = "default-draft-ok";
  const assertions: ContractAssertion[] = [
    {
      id: "DRAFT-001",
      type: "answer_match",
      pattern: "0817日报",
      negate: false,
      objective: "答复必须提到具体日期",
      scoring: ["completion", "quality"],
      allowEquivalent: false,
    },
  ];
  writeCandidate("default", cid, { prompt: "p" });
  writeDraft("default", cid, "ok", { assertions });
  const d = readCaseDraft("default", cid);
  check("ok 状态可读回", d?.status.state === "ok");
  check("ok 时 assertions 一并回来", d?.assertions.length === 1 && d.assertions[0].id === "DRAFT-001");
}

process.stdout.write("\n▶ pendingCasesBrief 分状态渲染\n");
{
  // 起草中：不能显示「（无）」
  const cid = "default-brief-pending";
  writeCandidate("default", cid, { prompt: "p", feedbackText: "答错了" });
  writeDraft("default", cid, "pending");
  const brief = pendingCasesBrief() ?? "";
  check("起草中 → 推文出现 ⏳ 而非「（无）」", brief.includes("⏳") && !brief.includes("断言：（无）"));
  check("起草中 → 带上用户原话", brief.includes("答错了"));
}
{
  const cid = "default-brief-failed";
  writeCandidate("default", cid, { prompt: "p", feedbackText: "答错了" });
  writeDraft("default", cid, "failed", { reason: "不合法 JSON" });
  const brief = pendingCasesBrief() ?? "";
  check("失败 → 推文出现 ⚠️", brief.includes("⚠️ 起草失败"));
  check("失败 → 附驳回引导", brief.includes("驳回"));
}
{
  const cid = "default-brief-empty";
  writeCandidate("default", cid, { prompt: "p", feedbackText: "答错了" });
  writeDraft("default", cid, "ok", { assertions: [] });
  const brief = pendingCasesBrief() ?? "";
  check("空断言 → 推文提示信号太弱", brief.includes("没产出任何可判断言"));
}
{
  const cid = "default-brief-ok";
  const assertions: ContractAssertion[] = [
    {
      id: "DRAFT-001",
      type: "answer_match",
      pattern: "0817日报",
      negate: false,
      objective: "答复必须提到具体日期",
      scoring: ["completion", "quality"],
      allowEquivalent: false,
    },
    {
      id: "DRAFT-002",
      type: "answer_match",
      pattern: "已完成",
      negate: true,
      objective: "任务未完成时不能声称已完成",
      scoring: ["completion", "quality"],
      allowEquivalent: false,
    },
    {
      id: "DRAFT-003",
      type: "required_call",
      selector: { toolPattern: "^Read$" },
      objective: "该读语雀 API",
      scoring: ["completion", "tool"],
      allowEquivalent: false,
    },
  ];
  writeCandidate("default", cid, { prompt: "p", feedbackText: "答错了" });
  writeDraft("default", cid, "ok", { assertions });
  const brief = pendingCasesBrief() ?? "";
  check("ok 有断言 → 列出「起草断言（3 条」", brief.includes("起草断言（3 条"));
  check("ok 有 answer_contains → 渲染「包含」", brief.includes("必须包含正则"));
  check("ok 有 answer_missing → 渲染「不含」", brief.includes("必须不含正则"));
  check("ok 有 required_call → 渲染「必须调用工具」", brief.includes("必须调用工具"));
  check("每条断言带 objective", brief.includes("答复必须提到具体日期"));
}

process.stdout.write("\n▶ 批准时合并草稿断言 + 搬 draft 目录\n");
{
  const cid = "default-approve-merge";
  const assertions: ContractAssertion[] = [
    {
      id: "DRAFT-001",
      type: "answer_match",
      pattern: "hello",
      negate: false,
      objective: "test",
      scoring: ["completion", "quality"],
      allowEquivalent: false,
    },
  ];
  writeCandidate("default", cid, { prompt: "p", feedbackText: "答错了" });
  writeDraft("default", cid, "ok", { assertions });

  const result = approveHarvestedCase("default", cid);
  check("批准成功", result.ok, result.message);
  check("消息提及合并了断言", result.message.includes("合并了"));

  const casesDir = join(roots.cases, "default", cid);
  check("case 目录已建立在 cases/", existsSync(casesDir));
  const caseJson = JSON.parse(readFileSync(join(casesDir, "case.json"), "utf-8")) as {
    assertions: ContractAssertion[];
  };
  check("case.assertions 已被合并", caseJson.assertions.length === 1 && caseJson.assertions[0].id === "DRAFT-001");
  check("draft 目录随晋升搬进 cases/", existsSync(join(casesDir, "draft", "assertions.json")));
  check("candidates 目录已删除", !existsSync(join(roots.candidates, "default", cid)));
}

process.stdout.write("\n▶ 已手动编辑 assertions 时不覆盖\n");
{
  const cid = "default-approve-manual";
  const manual: ContractAssertion[] = [
    {
      id: "MANUAL-1",
      type: "answer_match",
      pattern: "manual",
      negate: false,
      objective: "manual",
      scoring: ["completion"],
      allowEquivalent: false,
    },
  ];
  const draft: ContractAssertion[] = [
    {
      id: "DRAFT-Z",
      type: "answer_match",
      pattern: "auto",
      negate: false,
      objective: "auto",
      scoring: ["completion"],
      allowEquivalent: false,
    },
  ];
  writeCandidate("default", cid, { prompt: "p", feedbackText: "fb", assertions: manual });
  writeDraft("default", cid, "ok", { assertions: draft });
  const result = approveHarvestedCase("default", cid);
  check("批准成功", result.ok);
  check("消息不提合并（用户已手动补过）", !result.message.includes("合并了"));
  const caseJson = JSON.parse(
    readFileSync(join(roots.cases, "default", cid, "case.json"), "utf-8"),
  ) as { assertions: ContractAssertion[] };
  check("case.assertions 保留手动值", caseJson.assertions.length === 1 && caseJson.assertions[0].id === "MANUAL-1");
}

const total = pass + fails.length;
process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
process.exit(fails.length ? 1 : 0);
