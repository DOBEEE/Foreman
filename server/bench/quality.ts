import fs from "node:fs";
import path from "node:path";
import { ExecutionRecord, MetricName, MetricResult, RunPaths } from "./types.js";
import { JudgeExecutor } from "./types.js";
import { judgeAsset } from "./rubrics.js";
import { metricFromJudgment } from "./metrics.js";

/** 四个由 LLM judge 打分的质量维度（completion 各评测器口径不同，不在此列） */
export const QUALITY_METRICS: Array<Exclude<MetricName, 'completion'>> = [
  'hallucination',
  'conventionCompliance',
  'toolAccuracy',
  'recovery',
];

export type QualityMetric = Exclude<MetricName, 'completion'>;

/**
 * case 声明了哪些质量维度的事实源。
 *
 * 解决的问题：采集来的 case 只带 `oracle/trace.json`（断言），没有冻结事实、也没有规约清单。
 * 照样去问 hallucination 和 conventionCompliance，rubric 会因为拿不到事实源判 invalid，
 * 一路降级成 unavailable，而 promoteBaseline 拒绝含 unavailable 的报告——
 * 结果是自动采集的 case **永远建不起基线**。
 *
 * 正确的做法不是放宽 rubric，而是**别问没给证据的问题**：维度记 not_applicable
 * （promoteBaseline 允许它），聚合公式一行不用改。
 *
 * 判据只看「事实源在不在」这种客观事实，不做任何质量推测：
 * - hallucination 必须有冻结事实。只有提问原文时，答复里几乎每条陈述都会算 unsupported，
 *   分数是噪声而不是信号
 * - conventionCompliance 必须有规约清单，否则没有可核验的 ruleText
 * - toolAccuracy 必须有断言文件，它的决策树入口就是 deterministicStatus
 * - recovery 永远算声明了：它自己会在「本次没出错」时判 not_applicable
 */
export function declaredQualityMetrics(params: {
  oracleRoot: string;
  conventionsPath?: string;
}): QualityMetric[] {
  const declared: QualityMetric[] = ['recovery'];
  if (fs.existsSync(path.join(params.oracleRoot, 'requirements.json'))) declared.push('hallucination');
  if (params.conventionsPath && fs.existsSync(params.conventionsPath)) declared.push('conventionCompliance');
  if (fs.existsSync(path.join(params.oracleRoot, 'trace.json'))) declared.push('toolAccuracy');
  return QUALITY_METRICS.filter((metric) => declared.includes(metric));
}

export const qualitySchema = (metric: MetricName) => ({
  type: 'object',
  required: ['schemaVersion', 'metric', 'evaluationStatus', 'units'],
  properties: {
    schemaVersion: { const: 1 },
    metric: { const: metric },
    evaluationStatus: { const: 'completed' },
    units: { type: 'array' },
  },
});

/** rubric 文件名与维度名不是一一对应，映射在这里收口 */
export function rubricAssetName(metric: string): string {
  if (metric === 'conventionCompliance') return 'convention';
  if (metric === 'toolAccuracy') return 'tool';
  return metric;
}

export function readRubric(metric: string, root: string): string {
  return fs.readFileSync(judgeAsset(rubricAssetName(metric), root), 'utf8');
}

/**
 * 跑四个质量维度的 judge。各评测器的差异全在 evidence 的组装方式与 rubricRoot 上，
 * 调用 judge、校验产出、换算指标这段流程完全一致，故收口在此。
 *
 * 失败要按性质分开，因为 invalid 会让整个 run 作废、基线无法建立：
 *
 * - 证据缺失 → invalid：harness/Oracle 的问题，这一 run 不可信
 * - judge 调用失败 → judge_error：评测侧故障
 * - judge 返回了但产出不可用（units 为空 / 未完成）→ unavailable：
 *   裁判或 rubric 的问题，**不是 Oracle 坏了**，不该连带废掉零 LLM 判出来的维度
 *
 * 实测教训：一次网关限流让 judge 返回空 units，旧判据把整轮评测报废（连撞两次），
 * 而确定性维度当时明明判出来了。
 */
export async function judgeQualityMetrics(params: {
  judge: JudgeExecutor;
  paths: RunPaths;
  execution: ExecutionRecord;
  rubricRoot: string;
  /** 证据文件绝对路径；缺失时传 undefined，四维统一记 invalid */
  evidenceFile?: string;
  evidence?: Record<string, unknown>;
  evidenceError?: string;
  /**
   * 本 case 声明了事实源的维度（见 declaredQualityMetrics）。未列出的不启 judge、
   * 记 not_applicable。缺省为全部四维，既有调用方行为不变。
   */
  declared?: QualityMetric[];
}): Promise<MetricResult[]> {
  const { judge, paths, execution, rubricRoot, evidenceFile, evidence, evidenceError } = params;
  const declared = params.declared ?? QUALITY_METRICS;
  return Promise.all(
    QUALITY_METRICS.map(async (metric) => {
      // case 没给这一维的事实源 —— 不问。问了只会拿到 invalid，
      // 而 invalid 会连带废掉整个 run 并堵死基线创建。
      if (!declared.includes(metric)) {
        return {
          metric, status: 'not_applicable', numerator: 0, denominator: 0, rate: null,
          details: { reason: 'case 未声明该维度的事实源，本次不予判定' },
        } satisfies MetricResult;
      }

      // 证据都没有 = Oracle/harness 侧坏了，这一 run 整个不可信
      if (!evidenceFile || !evidence) {
        return {
          metric, status: 'invalid', numerator: 0, denominator: 0, rate: null,
          details: { error: evidenceError ?? '通用证据未生成' },
        } satisfies MetricResult;
      }

      let result;
      try {
        result = await judge.evaluate(paths, {
          metric,
          rubric: readRubric(metric, rubricRoot),
          outputSchema: qualitySchema(metric),
          evidence,
          materials: [{ source: evidenceFile, target: 'input/evidence.json' }],
          run: { id: execution.executionId, root: paths.root },
        });
      } catch (error) {
        return {
          metric, status: 'judge_error', numerator: 0, denominator: 0, rate: null,
          details: { error: error instanceof Error ? error.message : String(error) },
        } satisfies MetricResult;
      }

      if (result.status === 'error' || !result.output) {
        return {
          metric, status: 'judge_error', numerator: 0, denominator: 0, rate: null,
          details: { error: result.error, transcript: result.transcriptFile },
        } satisfies MetricResult;
      }

      try {
        return metricFromJudgment(metric, result.output);
      } catch (error) {
        // 裁判给了回复但不可用（空 units / 未完成）。是评测侧的问题，
        // 判 unavailable 而不是 invalid——别让它废掉这一 run 的其他维度。
        return {
          metric, status: 'unavailable', numerator: 0, denominator: 0, rate: null,
          details: { error: error instanceof Error ? error.message : String(error), transcript: result.transcriptFile },
        } satisfies MetricResult;
      }
    }),
  );
}
