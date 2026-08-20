/**
 * 评测类型。
 *
 * Provenance：字段名与 agent-bench 的 `src/types.ts` **逐字一致**，因为
 * `metrics.ts` / `trace-assertions.ts` / `attribution.ts` 等承载五维口径的文件是
 * 照搬过来的，改字段名就等于改了评分语义。只裁掉 foreman 用不到的部分
 * （AIT target / engine / matrix / 多 judge executor）。
 *
 * 为什么是照搬而不是依赖 agent-bench：评测搬进进程内后，HTTP 端点、suite yaml、
 * engine/target 抽象整层消失（净减一半代码），且不再需要 sibling checkout。
 * 代价是「尺子和被量的东西同仓」，靠 evaluatorFingerprint 可检测 + 写入守卫不可改来兜。
 */

export type MetricName =
  | "completion"
  | "hallucination"
  | "conventionCompliance"
  | "toolAccuracy"
  | "recovery";

/** 五维聚合顺序，报告与对比都按它排 */
export const METRIC_NAMES: MetricName[] = [
  "completion",
  "hallucination",
  "conventionCompliance",
  "toolAccuracy",
  "recovery",
];

export interface MetricResult {
  metric: MetricName;
  /**
   * - evaluated：判出来了
   * - not_applicable：**确实**不适用（如本次没出错，recovery 无从谈起）
   * - unavailable：**判不了**（judge 挂了/无数据）。必须与 not_applicable 分开：
   *   跳过 not_applicable 的门禁如果把「判不了」也当不适用，坏掉的 judge 就成了放行通道
   * - invalid：Oracle 或 harness 本身坏了，这一 run 不可信
   * - judge_error：单次 judge 调用失败（聚合时按 unavailable 处理）
   */
  status: "evaluated" | "not_applicable" | "unavailable" | "invalid" | "judge_error";
  numerator: number;
  denominator: number;
  rate: number | null;
  details?: Record<string, unknown>;
}

/** 一次执行的边界记录：judge 的证据都从这里出发 */
export interface ExecutionRecord {
  schemaVersion: 1;
  executionId: string;
  startedAt: string;
  endedAt: string;
  status: "completed" | "failed";
  /** 最终答复全文 */
  answerText: string;
  /** 本次执行是否报错（含模型网关错误） */
  isError: boolean;
  /** 错误来源，用于把评测侧故障与员工行为失败分开 */
  errorSource?: "model_gateway" | "runtime";
  /** per-run 的 JSONL 轨迹绝对路径 */
  transcriptFile: string;
  artifacts: string[];
}

/** 一次 run 的目录布局。judge 只看 materialize 出来的只读副本，不看这里 */
export interface RunPaths {
  root: string;
  workspace: string;
  evidence: string;
  judge: string;
  oracle: string;
}

export interface CaseMeta {
  schemaVersion: 1;
  caseId: string;
  agentId: string;
  title?: string;
  enabled?: boolean;
  /** 采集来源，供报告区分「客观采集」与「经人工批准」 */
  source?: string;
}

export interface BenchmarkCase {
  root: string;
  meta: CaseMeta;
  /** 提问原文文件所在目录 */
  inputRoot: string;
  /** 封存 oracle 目录（断言 + 事实源 + 规约正文） */
  oracleRoot: string;
  prompt: string;
  /** 提问原文文件绝对路径，作为 hallucination 的事实源之一 */
  promptFile: string;
  /** 规约清单（可选）。没有它，conventionCompliance 这一维无从判定 */
  conventionsPath?: string;
  /** case 内容指纹，进 caseSet */
  fingerprint: string;
}

export interface RunResult {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  agentId: string;
  status: "completed" | "failed" | "invalid";
  execution: ExecutionRecord;
  metrics: MetricResult[];
  /**
   * 本次 run 里 judge 没能给出结论的维度。是账目不是判定：
   * run 仍可用（确定性维度照常出分），但门禁必须知道哪些维度「没被证明」。
   */
  degradedMetrics?: MetricName[];
  paths: RunPaths;
}

/**
 * Campaign 指纹。
 *
 * 比 agent-bench 少了 suite / executionProfile / judge 三项：那三项原本描述的是
 * 「配置文件里写的东西」，而配置可能与真实运行状态不符。搬进进程内后，岗位配置、
 * 评测师配置、经验库、skills 全部由 runtimeState 直接反映真实状态——
 * 少一层可以撒谎的中间物。
 */
export interface Fingerprints {
  /** 被测代码：git HEAD + 工作区哈希 */
  target: string;
  /** 参与本次评测的 case 集合 */
  caseSet: string;
  /** 评分依据（本目录内容哈希 + 语义版本） */
  evaluator: string;
  /** 服务运行期状态：岗位 profile / 经验库 / skills / 知识库索引 */
  runtimeState: string;
}

export interface CampaignReport {
  schemaVersion: 1;
  campaignId: string;
  agentId: string;
  startedAt: string;
  endedAt: string;
  runs: RunResult[];
  metrics: MetricResult[];
  fingerprints: Fingerprints;
}

/** 交给评测师的一次判定请求 */
export interface JudgeInput {
  metric: Exclude<MetricName, "completion">;
  rubric: string;
  outputSchema: Record<string, unknown>;
  evidence: Record<string, unknown>;
  materials: Array<{ source: string; target: string }>;
  run: { id: string; root: string };
}

export interface JudgeResult {
  metric: MetricName;
  status: "completed" | "error";
  output?: Record<string, unknown>;
  error?: string;
  transcriptFile: string;
  requestFingerprint: string;
}

export interface JudgeExecutor {
  evaluate(paths: RunPaths, input: JudgeInput): Promise<JudgeResult>;
}
