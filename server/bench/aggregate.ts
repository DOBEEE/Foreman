import { METRIC_NAMES, type MetricName, type MetricResult, type RunResult } from "./types.js";

/**
 * 五维聚合口径。
 *
 * Provenance：逐字照搬 agent-bench `src/campaign/runner.ts` 里的 aggregateMetrics
 * 与 spreadOf（只把 AGGREGATED_METRICS 换成本地的 METRIC_NAMES 常量、导出 aggregateMetrics）。
 * 这段决定五维分数怎么算，是「保持口径一致」的核心，刻意不做任何重写或优化。
 */

/** 逐次分数的离散度：门禁的容差直接取它——基线自己的波动幅度就是该维度的噪声带。 */
function spreadOf(rates: number[]): number | null {
  if (rates.length < 2) return null;
  return Number((Math.max(...rates) - Math.min(...rates)).toFixed(4));
}

const AGGREGATED_METRICS = METRIC_NAMES;

/**
 * 把各次 Run 的分数聚合成 Campaign 级结论。
 *
 * 两条判据值得单独说明：
 *
 * 1. 「判不了」不等于「不适用」。原实现在没有任何 evaluated 结果时一律返回
 *    not_applicable，于是一个坏掉的 judge（限流、超时、rubric 出错）会让该维度看起来
 *    「不适用」；而跳过不适用维度的门禁就此放行一切。现在只有**确实**全部
 *    not_applicable 才判 not_applicable，否则判 unavailable。
 *
 * 2. 必须输出离散度。LLM judge 有真实波动（实测同一提示词三次跑出
 *    hallucination 0 / 0.1667 / 0），门禁若做「精确不退化」会大量误杀，
 *    最后只会被关掉。spread 让门禁能改判「退化是否超出该维度自身的噪声带」。
 */
export function aggregateMetrics(runs: RunResult[]): MetricResult[] {
  return AGGREGATED_METRICS.map((metric) => {
    const values = runs.flatMap((run) => run.metrics.filter((item) => item.metric === metric));
    const evaluated = values.filter((item) => item.status === "evaluated");
    const perRunRates = evaluated.map((item) => item.rate).filter((rate): rate is number => rate !== null);
    const degraded = values.filter((item) => item.status === "unavailable" || item.status === "judge_error" || item.status === "invalid").length;
    const accounting = {
      runsCounted: evaluated.length,
      runsDegraded: degraded,
      perRunRates,
      spread: spreadOf(perRunRates),
    };

    if (metric === "completion") {
      const byCase = new Map<string, MetricResult[]>();
      for (const run of runs) {
        const result = run.metrics.find((item) => item.metric === metric);
        if (!result) continue;
        byCase.set(run.caseId, [...(byCase.get(run.caseId) ?? []), result]);
      }
      const cases = [...byCase.values()];
      const passed = cases.filter((caseRuns) => caseRuns.length > 0 && caseRuns.every((item) => item.status === "evaluated" && item.rate === 1)).length;
      return {
        metric, status: "evaluated", numerator: passed, denominator: cases.length,
        rate: cases.length ? Number((passed / cases.length).toFixed(4)) : null,
        details: { rule: "同一 case 的三次执行均完成全部断言才计为通过", ...accounting },
      };
    }

    if (!evaluated.length) {
      // 全是 not_applicable 才是真的不适用；只要有一次是判不了，这个维度就是「没结论」
      const genuinelyNotApplicable = values.length > 0 && values.every((item) => item.status === "not_applicable");
      if (genuinelyNotApplicable) {
        return { metric, status: "not_applicable", numerator: 0, denominator: 0, rate: null, details: accounting };
      }
      return {
        metric, status: "unavailable", numerator: 0, denominator: 0, rate: null,
        details: { ...accounting, reason: values.length ? "judge 未产出可用结论" : "本 Campaign 没有该维度的结果" },
      };
    }

    const numerator = evaluated.reduce((sum, item) => sum + item.numerator, 0);
    const denominator = evaluated.reduce((sum, item) => sum + item.denominator, 0);
    return {
      metric, status: "evaluated", numerator, denominator,
      rate: Number((numerator / denominator).toFixed(4)),
      details: accounting,
    };
  });
}
