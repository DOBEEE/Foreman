/**
 * 回归门禁判定逻辑的结构性校验（零 LLM，纯断言）。
 *
 * 为什么必须专测：这层门禁一旦判错，方向是**放行本该拦下的退化提案**——
 * 而且不会报错、不会有任何症状，只会在几天后表现为「员工变笨了但没人知道为什么」。
 * 尤其是三条容易写错的规则：
 * 1. runtimeState 必须**不同**（提示词就是本次变量；相同说明候选跑的还是旧提示词）；
 * 2. hallucination 方向相反（它是坏声明占比，升高才是退化）；
 * 3. promptSha 绑定（防止拿 A 版本的回归结果批准 B 版本）。
 *
 * 用法：npx tsx server/core/__fixtures__/check-regression-gate.ts
 */

import {
  checkAttachedEvidence,
  compareCampaigns,
  promptSha,
  type RegressionEvidence,
} from "../regression-gate.js";

let pass = 0;
const failed: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    process.stdout.write(`  ✔ ${name}\n`);
  } else {
    failed.push(name);
    process.stdout.write(`  ✘ ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

const APPARATUS = {
  suite: "s1",
  caseSet: "c1",
  evaluator: "e1",
  judge: "j1",
  executionProfile: "p1",
  target: "t1",
};

function campaign(
  id: string,
  rates: Record<string, number | null>,
  overrides: { fingerprints?: Record<string, string>; invalidRun?: boolean } = {},
) {
  return {
    campaignId: id,
    suiteId: "s1",
    profile: { id: "service" },
    runs: [{ status: overrides.invalidRun ? "invalid" : "completed" }],
    metrics: Object.entries(rates).map(([metric, rate]) => ({
      metric,
      status: rate === null ? "not_applicable" : "evaluated",
      rate,
    })),
    fingerprints: { ...APPARATUS, runtimeState: "rt-base", ...overrides.fingerprints },
  };
}

const BASE = { completion: 0.8, conventionCompliance: 0.8, toolAccuracy: 0.9, hallucination: 0.2 };

process.stdout.write("回归门禁判定\n");

// 1. 正常放行：一项提升、无一项劣化
check(
  "主指标有提升且无劣化 → pass",
  compareCampaigns(
    campaign("b", BASE) as never,
    campaign("c", { ...BASE, completion: 0.9 }, { fingerprints: { runtimeState: "rt-new" } }) as never,
  ).status === "pass",
);

// 2. 任一项劣化即拒
check(
  "toolAccuracy 下降 → regressed",
  compareCampaigns(
    campaign("b", BASE) as never,
    campaign("c", { ...BASE, toolAccuracy: 0.7 }, { fingerprints: { runtimeState: "rt-new" } }) as never,
  ).status === "regressed",
);

// 3. hallucination 方向相反：升高是退化
const halluUp = compareCampaigns(
  campaign("b", BASE) as never,
  campaign("c", { ...BASE, hallucination: 0.4 }, { fingerprints: { runtimeState: "rt-new" } }) as never,
);
check("hallucination 升高 → regressed（方向相反）", halluUp.status === "regressed", halluUp.reason);
check(
  "hallucination 降低 → pass",
  compareCampaigns(
    campaign("b", BASE) as never,
    campaign("c", { ...BASE, hallucination: 0.1 }, { fingerprints: { runtimeState: "rt-new" } }) as never,
  ).status === "pass",
);

// 4. 全部持平 → no_improvement（仍放行，门禁语义是「不退化」）
check(
  "全部持平 → no_improvement",
  compareCampaigns(
    campaign("b", BASE) as never,
    campaign("c", BASE, { fingerprints: { runtimeState: "rt-new" } }) as never,
  ).status === "no_improvement",
);

// 5. runtimeState 相同 → 候选没真正生效，证据是假的
check(
  "runtimeState 与基线相同 → not_measured",
  compareCampaigns(campaign("b", BASE) as never, campaign("c", { ...BASE, completion: 1 }) as never).status ===
    "not_measured",
);

// 6. 评测装置变了 → 不可比
for (const key of ["suite", "caseSet", "evaluator", "judge", "executionProfile", "target"]) {
  const verdict = compareCampaigns(
    campaign("b", BASE) as never,
    campaign("c", { ...BASE, completion: 1 }, {
      fingerprints: { runtimeState: "rt-new", [key]: "changed" },
    }) as never,
  );
  check(`${key} 变化 → incomparable`, verdict.status === "incomparable", verdict.reason);
}

// 7. 候选含 invalid run → 结果不可信
check(
  "候选存在 invalid run → invalid_runs",
  compareCampaigns(
    campaign("b", BASE) as never,
    campaign("c", { ...BASE, completion: 1 }, {
      fingerprints: { runtimeState: "rt-new" },
      invalidRun: true,
    }) as never,
  ).status === "invalid_runs",
);

// 8. 单侧缺指标 → 不可比（不能当成没退化）
check(
  "某指标只有一侧评出 → incomparable",
  compareCampaigns(
    campaign("b", BASE) as never,
    campaign("c", { ...BASE, conventionCompliance: null }, {
      fingerprints: { runtimeState: "rt-new" },
    }) as never,
  ).status === "incomparable",
);

// 9. 两侧都没评出 → 跳过该项，不阻塞
check(
  "某指标两侧都 N/A → 跳过不阻塞",
  compareCampaigns(
    campaign("b", { ...BASE, conventionCompliance: null }) as never,
    campaign("c", { ...BASE, conventionCompliance: null, completion: 0.9 }, {
      fingerprints: { runtimeState: "rt-new" },
    }) as never,
  ).status === "pass",
);

process.stdout.write("\n证据绑定\n");

const PROMPT = "新版提示词正文";
const goodEvidence: RegressionEvidence = {
  campaignFile: "/tmp/x/campaign.json",
  promptSha: promptSha(PROMPT),
  status: "pass",
  reason: "ok",
  measuredAt: new Date().toISOString(),
};

check("证据齐备且 sha 匹配 → 放行", checkAttachedEvidence(goodEvidence, PROMPT).allow);
check("没有证据 → 拦下", !checkAttachedEvidence(undefined, PROMPT).allow);
check(
  "提案在测完之后被改过（sha 不匹配）→ 拦下",
  !checkAttachedEvidence(goodEvidence, `${PROMPT}（又改了一句）`).allow,
);
check(
  "no_improvement 也放行（门禁语义是不退化）",
  checkAttachedEvidence({ ...goodEvidence, status: "no_improvement" }, PROMPT).allow,
);
for (const status of ["regressed", "not_measured", "incomparable", "invalid_runs", "missing_baseline"] as const) {
  check(`${status} → 拦下`, !checkAttachedEvidence({ ...goodEvidence, status }, PROMPT).allow);
}

process.stdout.write(`\n━━━ ${pass}/${pass + failed.length} 通过 ━━━\n`);
if (failed.length) process.stdout.write(`未通过：${failed.join(", ")}\n`);
process.exit(failed.length ? 1 : 0);
