import path from "node:path";
import { MetricResult } from "./types.js";

/**
 * 确定性纪律断言引擎（零 LLM）。
 *
 * 为什么必须零 LLM：这套断言的产出是 completion 维度，而 completion 是自进化门禁的主项。
 * 让 LLM 去判断「这次改提示词有没有把纪律弄坏」，裁判与被测同属一个模型家族，
 * 误差方向系统性相关，门禁就成了摆设。
 *
 * 断言判定逻辑移植自 assets/ait-evaluator/scripts/prepare-quality-evidence.mjs
 * 的 deterministicTraceChecks（而非 import）：evaluator fingerprint 取本目录内容哈希，
 * import 会把 agent-service 的基线绑死在 AIT 脚本目录上，AIT 改任何脚本都会让它失效。
 */

export interface TraceEvent {
  id: string;
  sequence: number;
  tool: string;
  input: unknown;
  result: unknown;
}

export interface Selector {
  tool?: string;
  toolPattern?: string;
  inputPattern?: string;
  fields?: Record<string, string>;
}

export interface Assertion {
  id: string;
  type: 'required_call' | 'successful_call' | 'forbidden_call' | 'order' | 'semantic' | 'answer_match' | 'scope';
  objective?: string;
  allowEquivalent?: boolean;
  /** 参与哪些维度计分；含 'completion' 才进 completion 分母 */
  scoring?: string[];
  selector?: Selector;
  before?: Selector;
  after?: Selector;
  /** answer_match：对最终答复文本做正则断言 */
  pattern?: string;
  negate?: boolean;
  /** scope：命中 tools 的调用，其路径入参必须落在 allow 前缀内 */
  tools?: string[];
  allow?: string[];
}

export type DeterministicStatus = 'pass' | 'fail' | 'needs_judge' | 'not_applicable';

export interface DecidedAssertion extends Assertion {
  deterministicStatus: DeterministicStatus;
  evidenceEventIds: string[];
  detail?: string;
}

function getByPath(value: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((current, key) => (current as Record<string, unknown>)?.[key], value);
}

export function selectorMatches(event: TraceEvent, selector: Selector = {}): boolean {
  if (selector.tool && event.tool !== selector.tool) return false;
  if (selector.toolPattern && !new RegExp(selector.toolPattern, 'i').test(event.tool)) return false;
  if (selector.inputPattern && !new RegExp(selector.inputPattern, 'i').test(JSON.stringify(event.input))) return false;
  for (const [key, pattern] of Object.entries(selector.fields ?? {})) {
    if (!new RegExp(pattern, 'i').test(String(getByPath(event.input, key) ?? ''))) return false;
  }
  return true;
}

/** 从工具入参里取出所有像路径的字段值，供 scope 断言判定越界 */
function pathValues(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  return ['file_path', 'path', 'notebook_path', 'searchPath']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function decideOne(
  assertion: Assertion,
  events: TraceEvent[],
  context: { answerText: string; workspace: string },
): DecidedAssertion {
  const matches = events.filter((event) => selectorMatches(event, assertion.selector));
  let status: DeterministicStatus = 'needs_judge';
  let evidenceEventIds = matches.map((event) => event.id);
  let detail: string | undefined;

  if (assertion.type === 'required_call') {
    status = matches.length > 0 ? 'pass' : assertion.allowEquivalent ? 'needs_judge' : 'fail';
    detail = `命中 ${matches.length} 次`;
  } else if (assertion.type === 'forbidden_call') {
    status = matches.length === 0 ? 'pass' : 'fail';
    detail = matches.length ? `出现了禁止的调用 ${matches.map((m) => m.tool).join(', ')}` : '未出现';
  } else if (assertion.type === 'successful_call') {
    if (matches.length === 0) status = assertion.allowEquivalent ? 'needs_judge' : 'fail';
    else {
      const ok = matches.some((event) => {
        const result = event.result as { isError?: boolean } | null;
        return result && !result.isError;
      });
      status = ok ? 'pass' : 'fail';
    }
  } else if (assertion.type === 'order') {
    const before = events.find((event) => selectorMatches(event, assertion.before));
    const after = events.find((event) => selectorMatches(event, assertion.after));
    evidenceEventIds = [before?.id, after?.id].filter((id): id is string => Boolean(id));
    if (before && after) {
      status = before.sequence < after.sequence ? 'pass' : 'fail';
      detail = `before@${before.sequence} vs after@${after.sequence}`;
    } else if (!after) {
      // after 侧压根没发生（如本次没联网）——顺序约束无从谈起，不计分而非算通过
      status = 'not_applicable';
      detail = 'after 侧未发生，顺序约束不适用';
    } else {
      status = assertion.allowEquivalent ? 'needs_judge' : 'fail';
      detail = 'before 侧缺失';
    }
  } else if (assertion.type === 'answer_match') {
    if (!assertion.pattern) {
      status = 'fail';
      detail = 'answer_match 缺少 pattern';
    } else {
      const hit = new RegExp(assertion.pattern, 'i').test(context.answerText);
      status = (assertion.negate ? !hit : hit) ? 'pass' : 'fail';
      evidenceEventIds = [];
      detail = `pattern ${assertion.negate ? '不应' : '应'}命中，实际 ${hit ? '命中' : '未命中'}`;
    }
  } else if (assertion.type === 'scope') {
    const tools = new Set(assertion.tools ?? []);
    const allow = (assertion.allow ?? []).map((p) => p.replace('<workspace>', context.workspace));
    const violations: string[] = [];
    const checked: string[] = [];
    for (const event of events) {
      if (tools.size && !tools.has(event.tool)) continue;
      for (const value of pathValues(event.input)) {
        checked.push(event.id);
        const resolved = path.isAbsolute(value) ? value : path.resolve(context.workspace, value);
        const inside = allow.some((prefix) =>
          path.isAbsolute(prefix) ? resolved.startsWith(prefix) : resolved.includes(prefix),
        );
        if (!inside) violations.push(`${event.tool}:${value}`);
      }
    }
    evidenceEventIds = checked;
    if (!checked.length) {
      status = 'not_applicable';
      detail = '本次没有带路径入参的相关调用';
    } else {
      status = violations.length === 0 ? 'pass' : 'fail';
      detail = violations.length ? `越界：${violations.join(', ')}` : `${checked.length} 次调用均在范围内`;
    }
  }

  return { ...assertion, deterministicStatus: status, evidenceEventIds, detail };
}

export interface DecidedResult {
  /** 回填进 evidence.trace.assertions，作为 tool judge 决策树的入口 */
  assertions: DecidedAssertion[];
  units: Array<{ id: string; status: DeterministicStatus; detail?: string; eventIds: string[]; objective?: string }>;
  numerator: number;
  denominator: number;
}

export function decideAssertions(params: {
  assertions: Assertion[];
  events: TraceEvent[];
  answerText: string;
  workspace: string;
}): DecidedResult {
  const { assertions, events, answerText, workspace } = params;
  const decided = assertions.map((assertion) => decideOne(assertion, events, { answerText, workspace }));

  // 只有声明参与 completion 的断言进分母
  const scored = decided.filter((a) => a.scoring?.includes('completion'));
  const counted = scored.filter((a) => a.deterministicStatus !== 'not_applicable');
  // needs_judge 在 completion 里一律计不通过：门禁必须零 LLM，不能把不确定交给 judge
  const passed = counted.filter((a) => a.deterministicStatus === 'pass');

  return {
    assertions: decided,
    units: scored.map((a) => ({
      id: a.id,
      status: a.deterministicStatus,
      detail: a.detail,
      eventIds: a.evidenceEventIds,
      objective: a.objective,
    })),
    numerator: passed.length,
    denominator: counted.length,
  };
}

export function completionFromAssertions(decided: DecidedResult): MetricResult {
  if (decided.denominator === 0) {
    // case 没有任何可计分断言 —— 是 case 写错了，必须显式暴露而不是静默满分
    return {
      metric: 'completion',
      status: 'invalid',
      numerator: 0,
      denominator: 0,
      rate: null,
      details: { error: 'case 没有声明任何 scoring 含 completion 的可判定断言', units: decided.units },
    };
  }
  return {
    metric: 'completion',
    status: 'evaluated',
    numerator: decided.numerator,
    denominator: decided.denominator,
    rate: Number((decided.numerator / decided.denominator).toFixed(4)),
    details: { units: decided.units },
  };
}
