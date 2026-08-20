import {
  buildAssertionEvidence,
  checkAssertionEvidence,
  compareAssertionSnapshots,
  snapshotAssertions,
  type AssertionSnapshot,
} from "../assertion-gate.js";
import type { RegressionReport } from "../../bench/regression.js";
import type { DeterministicStatus } from "../../bench/trace-assertions.js";

/**
 * 一层门禁判据的确定性断言。
 *
 * 重点覆盖三条防篡改路径：删 case、候选轮 invalid、断言由通过变为不再被检查。
 * 这三条都是「不看着就会被走通」的过闸方式。
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

function snap(caseSet: string, statuses: Record<string, DeterministicStatus>, invalidCases: string[] = []): AssertionSnapshot {
  return { campaignId: `c-${caseSet}`, caseSet, statuses, invalidCases };
}

process.stdout.write("\n── 快照只取参与计分的断言 ──\n");
{
  const report = {
    schemaVersion: 1,
    campaignId: "r1",
    agentId: "assistant",
    startedAt: "",
    endedAt: "",
    caseSet: "cs1",
    summary: { total: 2, passed: 1, failed: 1, invalid: 1 },
    cases: [
      {
        caseId: "c1",
        agentId: "assistant",
        status: "failed" as const,
        completion: { metric: "completion" as const, status: "evaluated" as const, numerator: 0, denominator: 1, rate: 0 },
        assertions: [
          { id: "A", type: "required_call" as const, scoring: ["completion"], deterministicStatus: "fail" as const, evidenceEventIds: [] },
          { id: "B", type: "required_call" as const, scoring: ["tool"], deterministicStatus: "fail" as const, evidenceEventIds: [] },
        ],
        execution: {} as never,
        root: "",
      },
      {
        caseId: "c2",
        agentId: "assistant",
        status: "invalid" as const,
        completion: { metric: "completion" as const, status: "invalid" as const, numerator: 0, denominator: 0, rate: null },
        assertions: [],
        execution: {} as never,
        root: "",
      },
    ],
  } satisfies RegressionReport;

  const s = snapshotAssertions(report);
  check("只有 scoring 含 completion 的断言进快照", Object.keys(s.statuses).join(",") === "c1::A", Object.keys(s.statuses).join(","));
  check("invalid case 单列而不是当成没断言", s.invalidCases.join(",") === "c2");
}

process.stdout.write("\n── 判据 A：目标断言必须真的翻转 ──\n");
{
  const before = snap("cs1", { "c1::A": "fail", "c1::B": "pass" });
  const fixedAfter = snap("cs1", { "c1::A": "pass", "c1::B": "pass" });
  const v1 = compareAssertionSnapshots(before, fixedAfter, [{ caseId: "c1", assertionId: "A" }]);
  check("目标断言 fail→pass 判 pass", v1.status === "pass", `${v1.status}: ${v1.reason}`);
  check("fixed 列出被修好的断言", v1.fixed.join(",") === "c1::A");

  const notFixed = snap("cs1", { "c1::A": "fail", "c1::B": "pass" });
  const v2 = compareAssertionSnapshots(before, notFixed, [{ caseId: "c1", assertionId: "A" }]);
  check("目标断言没翻转判 not_fixed（不看比率，看因果）", v2.status === "not_fixed", v2.status);

  // 拿一条本来就绿的断言当业绩：提案依据不成立
  const v3 = compareAssertionSnapshots(before, fixedAfter, [{ caseId: "c1", assertionId: "B" }]);
  check("目标断言改动前就已通过 → 依据不成立", v3.status === "not_fixed" && v3.reason.includes("改动前就已通过"), v3.reason);

  const v4 = compareAssertionSnapshots(before, fixedAfter, [{ caseId: "c9", assertionId: "Z" }]);
  check("目标断言不在 case 集合里 → 拒", v4.status === "not_fixed" && v4.reason.includes("不在本次 case 集合里"));

  const v5 = compareAssertionSnapshots(before, fixedAfter, []);
  check("没声明目标 → no_target，只能确认没弄坏别的", v5.status === "no_target", v5.status);
  check("no_target 不放行（无法验证效果的改动不该生效）", !checkAssertionEvidence(
    buildAssertionEvidence({ proposedPrompt: "x", before, after: fixedAfter, targets: [] }).evidence, "x",
  ).allow);
}

process.stdout.write("\n── 判据 B：不许弄坏既有断言 ──\n");
{
  const before = snap("cs1", { "c1::A": "fail", "c1::B": "pass" });
  const broke = snap("cs1", { "c1::A": "pass", "c1::B": "fail" });
  const v = compareAssertionSnapshots(before, broke, [{ caseId: "c1", assertionId: "A" }]);
  check("修好 A 但弄坏 B → broke_others（这就是「不会再犯」的保证）", v.status === "broke_others", v.status);
  check("即使目标断言修好了也不放行", v.broken.join(",") === "c1::B");

  // 断言从「通过」变成「不再被检查」——DGM 实证过的 reward hacking 形态
  const weakened = snap("cs1", { "c1::A": "pass", "c1::B": "not_applicable" });
  const v2 = compareAssertionSnapshots(before, weakened, [{ caseId: "c1", assertionId: "A" }]);
  check("pass → not_applicable 也算弄坏", v2.status === "broke_others" && v2.broken[0].includes("不再被检查"), v2.broken.join(","));

  const vanished = snap("cs1", { "c1::A": "pass" });
  const v3 = compareAssertionSnapshots(before, vanished, [{ caseId: "c1", assertionId: "A" }]);
  check("断言在候选轮消失 → 弄坏（caseSet 相同却少断言只能是判定出错）", v3.status === "broke_others", v3.status);
}

process.stdout.write("\n── 防篡改：删 case / invalid 都不能当放行 ──\n");
{
  const before = snap("cs1", { "c1::A": "fail", "c2::A": "pass" });
  // 「把过不了的 case 删掉」是最省力的过闸方式
  const trimmed = snap("cs2", { "c2::A": "pass" });
  const v1 = compareAssertionSnapshots(before, trimmed, [{ caseId: "c1", assertionId: "A" }]);
  check("caseSet 不同即不可比", v1.status === "incomparable", v1.status);

  const invalidAfter = snap("cs1", { "c1::A": "pass", "c2::A": "pass" }, ["c3"]);
  const v2 = compareAssertionSnapshots(before, invalidAfter, [{ caseId: "c1", assertionId: "A" }]);
  check("候选轮有 invalid case → 拒（断言压根没判）", v2.status === "invalid_runs", v2.status);

  const invalidBefore = snap("cs1", { "c1::A": "fail" }, ["c2"]);
  const v3 = compareAssertionSnapshots(invalidBefore, snap("cs1", { "c1::A": "pass" }), [{ caseId: "c1", assertionId: "A" }]);
  check("基线轮有 invalid case → 拒（没有可比的起点）", v3.status === "invalid_runs", v3.status);
}

process.stdout.write("\n── 证据与提示词的绑定 ──\n");
{
  const before = snap("cs1", { "c1::A": "fail" });
  const after = snap("cs1", { "c1::A": "pass" });
  const { evidence } = buildAssertionEvidence({
    proposedPrompt: "候选提示词 v1",
    before,
    after,
    targets: [{ caseId: "c1", assertionId: "A" }],
  });
  check("同一段提示词放行", checkAssertionEvidence(evidence, "候选提示词 v1").allow);
  check(
    "测完之后提案被改过 → 拒（防「拿 A 的结果批准 B」）",
    !checkAssertionEvidence(evidence, "候选提示词 v2").allow,
  );
  check("没有证据 → 拒", !checkAssertionEvidence(undefined, "候选提示词 v1").allow);
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
