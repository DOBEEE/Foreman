/** workflow 步骤执行结果，落入任务档案 */
export interface StepRecord {
  id: string;
  title: string;
  status: "done" | "failed";
  /** 提炼后的步骤结论（parse 后，无 parse 则为全文） */
  conclusion: string;
  /** 步骤会话 ID，供答疑时定向深钻取证 */
  sessionId?: string;
  durationMs?: number;
}

/** 任务档案：workflow 执行完的结构化沉淀，也是答疑锚点会话的上下文来源 */
export interface TaskRecord {
  taskId: string;
  agent: string;
  /** 用户原始输入 */
  input: string;
  time: string;
  steps: StepRecord[];
  finalAnswer?: string;
}

/** 步骤上下文：buildPrompt 可读取用户输入与前序步骤结论 */
export interface StepContext {
  /** 用户原始输入 */
  input: string;
  /** 业务入参（请求 params） */
  params: Record<string, unknown>;
  /** 按步骤 id 取前序结论 */
  conclusionOf(stepId: string): string | undefined;
}

/** workflow 步骤声明：每步独立会话执行 */
export interface StepDef {
  id: string;
  title: string;
  /** 组装本步骤的 prompt（可引用前序结论） */
  buildPrompt(ctx: StepContext): string;
  /** 从步骤原始输出提炼结论，默认取全文 */
  parse?(text: string): string;
  /** 覆盖本步骤的 maxTurns */
  maxTurns?: number;
}
