/**
 * 五维口径与归因的**快照回归**断言（自包含，不依赖任何外部 checkout）。
 *
 * 沿革：评测从 agent-bench 搬进本仓时，用 check-metric-parity 做过「双实现等价」验证
 * （同一批 run 分别喂两边，五维与归因必须逐字一致）。移植已完成，那条判据的使命结束——
 * 但它是 `aggregateMetrics` / `attribute` 唯一的覆盖，直接删掉会让五维聚合彻底裸奔。
 *
 * 所以把当年那批**真实 campaign** 连同「已被双实现验证过的输出」固化进 metric-corpus/，
 * 转成快照回归：语料与期望都在仓库里，判据可离线复算，不再需要同级 agent-bench。
 * 拿外部会漂的 checkout 当长期参照物本身就不成立——它一旦演进，parity 要么失去意义、
 * 要么变成假失败。
 *
 * golden 的可信来源：生成时用当时仍在的 agent-bench 跑 check-metric-parity 交叉验证，
 * 14/14 全绿（2 份 campaign × 五维 + 归因），故快照不是「自我确认」。
 *
 * 何时该更新快照：只有在**刻意**变更五维口径或归因语义时；此时必须在 commit 里说明
 * 为什么新口径是对的。若非本意却红了，那就是漂移——这正是本 fixture 要拦的。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateMetrics } from "../aggregate.js";
import { attribute } from "../attribution.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

interface Snapshot {
  campaignId: string;
  runs: unknown[];
  expected: {
    metrics: Array<{
      metric: string;
      status: string;
      numerator: number;
      denominator: number;
      rate: number | null;
      details?: unknown;
    }>;
    findings: string[];
  };
}

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), "metric-corpus");
const files = readdirSync(corpusDir).filter((f) => f.endsWith(".json")).sort();

if (!files.length) {
  process.stdout.write("\n❌ metric-corpus/ 为空：快照语料丢失，五维聚合失去覆盖\n");
  process.exit(1);
}

process.stdout.write(`\n── 五维口径快照回归（${files.length} 份真实 campaign）──\n`);

const findingKey = (f: {
  category: string;
  metric: string;
  caseId: string;
  suggestedOwner: string;
}) => `${f.category}|${f.metric}|${f.caseId}|${f.suggestedOwner}`;

for (const file of files) {
  const snap = JSON.parse(readFileSync(join(corpusDir, file), "utf-8")) as Snapshot;
  const label = snap.campaignId.slice(0, 22);
  const mine = aggregateMetrics(snap.runs as never);

  check(
    `${label}：五维数量一致`,
    mine.length === snap.expected.metrics.length,
    `${mine.length} vs ${snap.expected.metrics.length}`,
  );

  for (const want of snap.expected.metrics) {
    const got = mine.find((x) => x.metric === want.metric);
    const eq =
      got !== undefined &&
      got.status === want.status &&
      got.numerator === want.numerator &&
      got.denominator === want.denominator &&
      got.rate === want.rate &&
      JSON.stringify(got.details) === JSON.stringify(want.details);
    check(
      `${label}：${want.metric} 口径与 details 完全一致`,
      eq,
      eq
        ? ""
        : `期望 ${want.status}/${want.numerator}/${want.denominator}/${want.rate}，实际 ${got?.status}/${got?.numerator}/${got?.denominator}/${got?.rate}`,
    );
  }

  const myFindings = attribute({ runs: snap.runs } as never).map(findingKey).sort();
  const same = JSON.stringify(myFindings) === JSON.stringify(snap.expected.findings);
  check(
    `${label}：归因 ${snap.expected.findings.length} 条 finding 语义一致`,
    same,
    same
      ? ""
      : `\n    期望: ${snap.expected.findings.join(", ")}\n    实际: ${myFindings.join(", ")}`,
  );
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
