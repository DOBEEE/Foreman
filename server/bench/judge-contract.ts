import fs from "node:fs";
import path from "node:path";
import { JudgeInput } from "./types.js";

/**
 * 判定契约：产出解析、越界证据校验、评测师运行期提示词。
 *
 * Provenance：逐字照搬 agent-bench 的 `src/judge/contract.ts`
 * （仅改 import 路径、去掉与 types.ts 重复的 JudgeExecutor 声明）。
 *
 * validateEvidenceReferences 是「裁判不能编造证据」的强制点：引用的 source 必须是
 * 物化工作目录内真实存在的路径。canonical() 的 realpath 归一不可省——macOS 上
 * /tmp 是 /private/tmp 的符号链接，不归一会把合法证据判成越界，症状是随机
 * judge_error 且极难定位（实测踩过）。
 */

export function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Judge 最终消息不包含 JSON 对象');
  return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * 路径归一：符号链接两侧必须解析到同一形态才能比较。
 * macOS 上 /tmp 是 /private/tmp 的符号链接，judge 在工作目录内解析出的绝对路径
 * 往往是 realpath，而 workspace 是调用方给的原始路径——不归一就会把合法证据
 * 判成「引用了工作目录外的证据」，症状是随机 judge_error，极难定位。
 */
function canonical(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function validateEvidenceReferences(value: Record<string, unknown>, workspace: string): void {
  const root = canonical(workspace);
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const source = record.source;
    if (typeof source === 'string' && path.isAbsolute(source)) {
      if (!fs.existsSync(source)) throw new Error(`Judge 引用了工作目录外或不存在的证据: ${source}`);
      const relative = path.relative(root, canonical(source));
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Judge 引用了工作目录外或不存在的证据: ${source}`);
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
}

export function validateJudgeOutput(input: JudgeInput, output: Record<string, unknown>, workspace: string): void {
  if (output.schemaVersion !== 1) throw new Error('Judge 输出 schemaVersion 必须为 1');
  if (output.metric !== input.metric) throw new Error(`Judge 输出 metric 不匹配: ${String(output.metric)}`);
  if (typeof output.evaluationStatus !== 'string') throw new Error('Judge 输出缺少 evaluationStatus');
  if (!Array.isArray(output.units)) throw new Error('Judge 输出缺少 units 数组');
  validateEvidenceReferences(output, workspace);
}

export function judgeRuntimePrompt(input: JudgeInput): string {
  return [
    '你是独立的 Benchmark Judge，只评测已经生成的证据，不执行被测任务。',
    `本次评测维度：${input.metric}。`,
    '读取 input/rubric.md、input/evidence.json 和 input/output-schema.json。证据引用的只读材料位于 materials/。',
    '严格遵守 rubric 的状态机、决策树、单位集合和证据规则。',
    '禁止修改文件，禁止访问当前 Judge 工作目录之外的路径，禁止调用网络或子 Agent。',
    '最终只返回一个符合 output-schema.json 的 JSON 对象，不要输出 Markdown 或解释。',
  ].join('\n');
}
