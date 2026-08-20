import { MetricName, MetricResult } from "./types.js";

function unitsOf(value: Record<string, unknown>): Array<Record<string, unknown>> {
  const units = value.units;
  if (!Array.isArray(units) || !units.length) throw new Error('Judge 未返回非空 units');
  return units as Array<Record<string, unknown>>;
}

export function metricFromJudgment(metric: Exclude<MetricName, 'completion'>, value: Record<string, unknown>): MetricResult {
  if (value.evaluationStatus !== 'completed') throw new Error(`${metric} Judge 未完成`);
  if (metric === 'recovery' && value.applicability === 'not_applicable') {
    return { metric, status: 'not_applicable', numerator: 0, denominator: 0, rate: null, details: value };
  }
  const units = unitsOf(value);
  if (metric === 'hallucination') {
    const failed = units.filter((unit) => unit.verdict !== 'supported').length;
    return { metric, status: 'evaluated', numerator: failed, denominator: units.length, rate: Number((failed / units.length).toFixed(4)), details: value };
  }
  if (metric === 'conventionCompliance') {
    const passed = units.filter((unit) => unit.status === 'pass').length;
    return { metric, status: 'evaluated', numerator: passed, denominator: units.length, rate: Number((passed / units.length).toFixed(4)), details: value };
  }
  if (metric === 'toolAccuracy') {
    const scored = units.filter((unit) => unit.status !== 'not_applicable');
    const passed = scored.filter((unit) => unit.status === 'correct' || unit.status === 'equivalent').length;
    if (!scored.length) return { metric, status: 'not_applicable', numerator: 0, denominator: 0, rate: null, details: value };
    return { metric, status: 'evaluated', numerator: passed, denominator: scored.length, rate: Number((passed / scored.length).toFixed(4)), details: value };
  }
  const passed = units.filter((unit) => unit.status === 'recovered' || unit.status === 'bypassed').length;
  return { metric, status: 'evaluated', numerator: passed, denominator: units.length, rate: Number((passed / units.length).toFixed(4)), details: value };
}
