import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredQualityMetrics } from "../quality.js";
import { routeOf, attributeAssertions, type FindingCategory } from "../attribution.js";
import { decideAssertions, completionFromAssertions } from "../trace-assertions.js";
import type { RegressionReport } from "../regression.js";

/**
 * 一层回归 + 归因路由的确定性断言。
 *
 * 这些全是纯函数，不需要 LLM、不需要起服务 —— 这本身就是一层的设计要点：
 * 判据可以被离线复算，才谈得上「门禁」。
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

process.stdout.write("\n── 维度声明（别问没给证据的问题）──\n");
{
  const oracleRoot = mkdtempSync(join(tmpdir(), "bench-oracle-"));
  writeFileSync(join(oracleRoot, "trace.json"), JSON.stringify({ assertions: [] }), "utf-8");

  const harvested = declaredQualityMetrics({ oracleRoot });
  check(
    "采集 case（只有 trace.json）不问 hallucination",
    !harvested.includes("hallucination"),
    harvested.join("/"),
  );
  check(
    "采集 case 不问 conventionCompliance",
    !harvested.includes("conventionCompliance"),
    harvested.join("/"),
  );
  check("采集 case 仍问 toolAccuracy（断言在，决策树有入口）", harvested.includes("toolAccuracy"));
  check("recovery 永远声明（它自己判本次有没有出错）", harvested.includes("recovery"));

  writeFileSync(join(oracleRoot, "requirements.json"), JSON.stringify({ facts: [] }), "utf-8");
  const conventionsPath = join(oracleRoot, "conventions-ref.json");
  writeFileSync(conventionsPath, JSON.stringify({ items: [] }), "utf-8");
  const curated = declaredQualityMetrics({ oracleRoot, conventionsPath });
  check("精选 case 补齐事实源后四维全声明", curated.length === 4, curated.join("/"));

  // 声明了但文件不在 —— 不能当声明了，否则 rubric 拿不到事实源仍会判 invalid
  const missing = declaredQualityMetrics({ oracleRoot, conventionsPath: join(oracleRoot, "nope.json") });
  check("conventions 路径指向不存在的文件不算声明", !missing.includes("conventionCompliance"));
}

process.stdout.write("\n── 归因路由（8 类收成 4 个落点）──\n");
{
  const routes: Array<[FindingCategory, string]> = [
    ["prompt", "prompt"],
    ["rule", "prompt"],
    ["model_hallucination", "prompt"],
    ["knowledge", "knowledge"],
    ["tool", "code"],
    ["orchestration", "code"],
    ["dependency", "code"],
    ["environment", "discard"],
  ];
  for (const [category, expected] of routes) {
    check(`${category} → ${expected}`, routeOf(category) === expected, routeOf(category));
  }
}

process.stdout.write("\n── 断言判定与断言级归因 ──\n");
{
  const events = [
    { id: "e1", sequence: 0, tool: "Grep", input: { pattern: "经验库", path: "/k/agent-base" }, result: { isError: false } },
    { id: "e2", sequence: 1, tool: "Write", input: { file_path: "/tmp/x.md" }, result: { isError: false } },
  ];
  const decided = decideAssertions({
    assertions: [
      { id: "TOOL-001", type: "required_call", scoring: ["completion"], selector: { tool: "Grep" }, objective: "必须先检索" },
      { id: "CONTRACT-READONLY", type: "forbidden_call", scoring: ["completion"], selector: { toolPattern: "^(Write|Edit)$" }, objective: "只读岗位不得写" },
      { id: "NOTE-ONLY", type: "required_call", scoring: ["tool"], selector: { tool: "WebSearch" }, objective: "不计入 completion" },
    ],
    events,
    answerText: "见 agent-base.md",
    workspace: "/tmp/ws",
  });

  check("required_call 命中判 pass", decided.assertions[0].deterministicStatus === "pass");
  check("forbidden_call 出现禁止调用判 fail", decided.assertions[1].deterministicStatus === "fail");
  check(
    "只有 scoring 含 completion 的进分母",
    decided.denominator === 2,
    `分母 ${decided.denominator}`,
  );
  const completion = completionFromAssertions(decided);
  check("completion 出分 1/2", completion.rate === 0.5, String(completion.rate));

  const empty = completionFromAssertions(
    decideAssertions({ assertions: [], events: [], answerText: "", workspace: "/tmp/ws" }),
  );
  check("没有可计分断言判 invalid 而非静默满分", empty.status === "invalid", empty.status);

  const report = {
    schemaVersion: 1,
    campaignId: "t",
    agentId: "assistant",
    startedAt: "",
    endedAt: "",
    caseSet: "x",
    summary: { total: 1, passed: 0, failed: 1, invalid: 0 },
    cases: [
      {
        caseId: "c1",
        agentId: "assistant",
        status: "failed" as const,
        completion,
        assertions: decided.assertions,
        execution: {} as never,
        root: "/tmp",
      },
    ],
  } satisfies RegressionReport;

  const findings = attributeAssertions(report);
  check("只对失败的计分断言产 finding", findings.length === 1, `${findings.length} 条`);
  check(
    "forbidden_call 失败归 rule（不是笼统的 prompt）",
    findings[0]?.category === "rule",
    findings[0]?.category,
  );
  check("rule 的去向是 prompt", routeOf(findings[0].category) === "prompt");
  check(
    "证据带断言 id 与实际情况，优化师可一对一改",
    findings[0].evidence.includes("CONTRACT-READONLY") && findings[0].evidence.includes("出现了禁止的调用"),
  );

  const invalidFindings = attributeAssertions({
    ...report,
    cases: [{ ...report.cases[0], status: "invalid", invalidReason: "基础设施故障（model_gateway）" }],
  });
  check(
    "invalid 归 environment → discard，不进优化循环",
    invalidFindings[0]?.category === "environment" && routeOf(invalidFindings[0].category) === "discard",
  );
}

process.stdout.write("\n── needs_judge 不甩锅给员工 ──\n");
{
  const decided = decideAssertions({
    assertions: [
      {
        id: "SEM-001",
        type: "semantic",
        scoring: ["completion"],
        selector: { tool: "Read" },
        objective: "语义类断言在零 LLM 层判不了",
      },
    ],
    events: [],
    answerText: "",
    workspace: "/tmp/ws",
  });
  check("semantic 判 needs_judge", decided.assertions[0].deterministicStatus === "needs_judge");
  check("needs_judge 在 completion 里计不通过", decided.numerator === 0 && decided.denominator === 1);
  const findings = attributeAssertions({
    schemaVersion: 1,
    campaignId: "t",
    agentId: "a",
    startedAt: "",
    endedAt: "",
    caseSet: "x",
    summary: { total: 1, passed: 0, failed: 1, invalid: 0 },
    cases: [
      {
        caseId: "c",
        agentId: "a",
        status: "failed",
        completion: completionFromAssertions(decided),
        assertions: decided.assertions,
        execution: {} as never,
        root: "/tmp",
      },
    ],
  });
  check(
    "但归因指向 harness 而非员工提示词",
    findings[0]?.category === "environment" && findings[0]?.suggestedOwner === "harness",
    `${findings[0]?.category}/${findings[0]?.suggestedOwner}`,
  );
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
