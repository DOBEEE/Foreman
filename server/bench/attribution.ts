import { CampaignReport, RunResult } from "./types.js";
import type { RegressionReport } from "./regression.js";
import type { DecidedAssertion } from "./trace-assertions.js";

/**
 * 失败归因。
 *
 * Provenance：逐字照搬 agent-bench 的 `src/report/attribution.ts`，
 * 逐条 finding 的类别映射与跳过规则**一字未动**。只做三处必要适配：
 *   1. 删掉 MatrixReport 输入形态（多引擎对比是 agent-bench 才有的场景）
 *   2. profileId → agentId（foreman 用 agentId 标识岗位），纯字段改名
 *   3. `execution.process.exitCode !== 0` → `execution.isError`
 *      （不含子进程，语义等价：进程失败 ⇔ 本次执行报错）
 */

export type FindingCategory = 'prompt' | 'orchestration' | 'rule' | 'knowledge' | 'dependency' | 'environment' | 'model_hallucination' | 'tool';
export interface Finding { id: string; category: FindingCategory; metric: string; caseId: string; agentId: string; evidence: string; suggestedOwner: string; }

function findingsForRun(run: RunResult): Finding[] {
  const results: Finding[] = [];
  for (const metric of run.metrics) {
    if (metric.status === 'evaluated' && (metric.rate === 1 || metric.metric === 'hallucination' && metric.rate === 0)) continue;
    // 确实不适用的维度没有可归因的东西。不跳过的话「本次没出错」每轮都会产出
    // 一条 recovery/orchestration finding，纯噪声。
    if (metric.status === 'not_applicable') continue;
    // judge 判不了是**评测侧**故障。按维度名归因会让优化师因为裁判限流
    // 去改被测员工的提示词——归因完全错位。
    if (metric.status === 'unavailable' || metric.status === 'judge_error') {
      results.push({
        id: `${run.agentId}-${run.caseId}-${metric.metric}-judge`,
        category: 'environment', metric: metric.metric, caseId: run.caseId, agentId: run.agentId,
        evidence: `judge 未产出结论（评测侧故障，不指向提示词）：${JSON.stringify(metric.details ?? {}).slice(0, 2000)}`,
        suggestedOwner: 'harness',
      });
      continue;
    }
    const category: FindingCategory = metric.metric === 'hallucination' ? 'model_hallucination'
      : metric.metric === 'conventionCompliance' ? 'knowledge'
      : metric.metric === 'toolAccuracy' ? 'tool'
      : metric.metric === 'recovery' ? 'orchestration'
      : run.execution.isError ? 'environment' : 'prompt';
    results.push({ id: `${run.agentId}-${run.caseId}-${metric.metric}`, category, metric: metric.metric, caseId: run.caseId, agentId: run.agentId, evidence: JSON.stringify(metric.details ?? {}).slice(0, 4000), suggestedOwner: category === 'knowledge' ? 'knowledge' : category === 'tool' ? 'workflow' : 'skill' });
  }
  return results;
}

export function attribute(input: CampaignReport): Finding[] {
  return input.runs.flatMap(findingsForRun);
}

/**
 * finding 的处理去向。
 *
 * category 保留 8 类是为了做统计（「这个月 tool 类占 60%」是给人看的有效信号），
 * 但**决策不该看它**：数一下实际去向只有 4 个，8 类里有 4 类没有独立落点。
 * 这种没被任何决策消费的精度是装饰，而且有害 —— 优化师看到 `model_hallucination`
 * 会以为「这是模型的锅不是我的锅」，就不改了。
 *
 * 刻意是纯函数而不是存储字段：派生数据不落盘，映射改了历史 finding 自动跟上。
 */
export type FindingRoute = 'prompt' | 'knowledge' | 'code' | 'discard';

export function routeOf(category: FindingCategory): FindingRoute {
  switch (category) {
    // 都是「改提示词/规约」，同一个落点。model_hallucination 也在这里：
    // 模型编事实，能做的就是把约束写进提示词
    case 'prompt':
    case 'rule':
    case 'model_hallucination':
      return 'prompt';
    case 'knowledge':
      return 'knowledge';
    // 提示词修不了，要人改代码或工具
    case 'tool':
    case 'orchestration':
    case 'dependency':
      return 'code';
    // 评测侧/基建故障，根本不该进优化循环
    case 'environment':
      return 'discard';
  }
}

/** 去向 → 负责人。discard 必须落到 harness：评测侧故障甩给员工提示词是最典型的归因错位 */
const OWNER_BY_ROUTE: Record<FindingRoute, string> = {
  prompt: 'skill',
  knowledge: 'knowledge',
  code: 'workflow',
  discard: 'harness',
};

/**
 * 断言类型 → 归因类别。
 *
 * 一层回归只有 completion 一个维度，若沿用 findingsForRun 的「按维度名映射」，
 * 所有失败都会落进 `prompt`，等于没分类。真正能定位责任的信息在**断言类型**里：
 * 「不该调的调了」和「该做的没做」是两种不同的问题，交给不同的人改。
 */
function categoryForAssertion(assertion: DecidedAssertion): FindingCategory {
  // 断言在零 LLM 层判不出来 = case 写得不可判定，是 case/harness 的问题。
  // 归到员工头上会让它为一条根本无法通过的标准反复被改。
  if (assertion.deterministicStatus === 'needs_judge') return 'environment';
  switch (assertion.type) {
    // 越权、越界：边界是招人时声明的，属于规约层
    case 'forbidden_call':
    case 'scope':
      return 'rule';
    // 该做的没做、顺序错、答复没达到要求：提示词层
    case 'required_call':
    case 'successful_call':
    case 'order':
    case 'answer_match':
    case 'semantic':
      return 'prompt';
  }
}

/** 一层回归报告 → findings。只对失败断言产出，通过的不产噪声 */
export function attributeAssertions(report: RegressionReport): Finding[] {
  const findings: Finding[] = [];
  for (const item of report.cases) {
    // invalid 是 case/环境的问题，不指向员工行为
    if (item.status === 'invalid') {
      findings.push({
        id: `${item.agentId}-${item.caseId}-invalid`,
        category: 'environment',
        metric: 'completion',
        caseId: item.caseId,
        agentId: item.agentId,
        evidence: item.invalidReason ?? 'case 或运行环境不可用',
        suggestedOwner: 'harness',
      });
      continue;
    }
    for (const assertion of item.assertions) {
      // 只有参与计分的断言才产 finding：没进分母的东西改了也不体现在判据里
      if (!assertion.scoring?.includes('completion')) continue;
      if (assertion.deterministicStatus === 'pass' || assertion.deterministicStatus === 'not_applicable') continue;
      const category = categoryForAssertion(assertion);
      findings.push({
        id: `${item.agentId}-${item.caseId}-${assertion.id}`,
        category,
        metric: 'completion',
        caseId: item.caseId,
        agentId: item.agentId,
        // 证据给的是「要求 + 实际」，优化师据此能一对一改提示词，
        // 而不是拿到一个 0.17 的比率无从下手
        evidence: JSON.stringify({
          assertion: assertion.id,
          type: assertion.type,
          status: assertion.deterministicStatus,
          objective: assertion.objective,
          detail: assertion.detail,
          eventIds: assertion.evidenceEventIds,
        }),
        suggestedOwner: OWNER_BY_ROUTE[routeOf(category)],
      });
    }
  }
  return findings;
}
