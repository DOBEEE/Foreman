/**
 * 编队（squad）类型：任务级临时协作的 plan 结构。
 * - lead 岗位在运行时用 submit_plan 工具产出 TeamPlan（任务的属性，跑完即散）
 * - SOP 型员工的固定步骤（profile.steps）在执行时也映射为同一结构，共用执行器
 */

import type { Contract } from "../../core/contract.js";
import type { ReviewRecord, StepReport } from "../../tools/step-report.js";

/** 临时工规格：组长在 plan 里现场定义的一次性执行者（无 profile、无经验库、不可当评审人） */
export interface TempWorkerSpec {
  /** 角色一句话（如「接口签名收集员」） */
  role: string;
  /** 系统提示词（可选，缺省由 role 生成） */
  prompt?: string;
  /** 工具白名单，缺省只读工具集 */
  tools?: string[];
  model?: string;
  maxTurns?: number;
}

/**
 * 步骤产出合约：声明本步执行完毕后必须存在的产物。
 * 引擎在步骤执行后自动校验——未满足则给执行者精准反馈重试（烧 maxRetries 预算）。
 * 下游步骤可通过 `needs` 声明依赖某上游步骤的合约；合约数据提取后支持
 * `{{step:id.field}}` 精确字段引用（不再只能注入整段结论文本）。
 *
 * 形状定义在 `core/contract.ts`：boss 的任务级验收（`Task.contract`）用的是同一套，
 * 放在 squad 下会形成 boss → squad 的反向依赖。这里只做别名，引用点不必改。
 */
export type StepContract = Contract;

export interface TeamStep {
  /** 步骤 id（plan 内唯一） */
  id: string;
  title: string;
  /**
   * 执行者：员工 id / "lead"（组长自己做，SOP self 步）/ "temp"（临时工，需同时给 temp 规格）
   */
  employee: string;
  /** employee="temp" 时的临时工规格 */
  temp?: TempWorkerSpec;
  /** 委派指令模板：支持 {{input}} / {{param.xxx}} / {{step:<前序id>}} / {{step:<id>.<field>}} */
  brief: string;
  /** 评审人员工 id：产出后由他真跑一轮评审，不过则执行者带意见重做 */
  reviewer?: string;
  /** 验收标准（自然语言）。有 reviewer 时给评审人用；无 reviewer 时组长轻量判定 */
  accept?: string;
  /** 验收不过的最大重做次数，默认 2 */
  maxRetries?: number;
  /** 覆盖本步 maxTurns（仅 employee="lead" 的自执行步生效） */
  maxTurns?: number;
  /** 产出合约：声明本步必须产出的文件和/或结构化数据字段 */
  produces?: StepContract;
  /** 依赖的上游步骤 id 列表：启动前校验上游合约，运行中可通过 reject_upstream 反馈 */
  needs?: string[];
}

export interface TeamPlan {
  /** 任务目标（组长澄清后的一句话表述） */
  goal: string;
  /** 整体验收标准 */
  acceptance?: string;
  steps: TeamStep[];
}

/**
 * 员工向组长提出的确认项（escalate 工具）。
 *
 * 为什么要结构化：早先编队协议让员工"把【需澄清】写在返回文本开头"，员工照做了，
 * 但那只是自然语言正文里的一段——引擎不认、组长收尾时也没有任何机器约束要求他回应，
 * 于是确认项静默消失（真实事故：任务 3537e7 的 coder 列了 3 条待确认，无一被处理）。
 * 落成字段后，收尾 prompt 就能把它当确定性清单摆出来，逼组长逐条表态。
 */
export interface Escalation {
  /** 提出者步骤 id */
  stepId: string;
  question: string;
  /** 员工给出的候选处理方式 */
  options?: string[];
  /** true = 员工认为拿不到答复就没法正确往下做（组长会当场作答） */
  blocking: boolean;
  /** 组长当场的答复；缺省 = 组长没答，收尾阶段必须处理 */
  leadAnswer?: string;
}

export interface StepOutcome {
  id: string;
  title: string;
  employee: string;
  /** done=完成（可能带 ⚠️ 未过验收标注） / failed=执行异常 */
  status: "done" | "failed";
  conclusion: string;
  /** 实际执行次数（含重做 + 上游反馈修补） */
  attempts: number;
  /**
   * 引擎侧的重试原因（未按协议交卷 / 产出合约缺失 / 评审打回 …）。
   *
   * 早先这个字段叫 `reviewNotes`，而组长侧把它渲染成「评审记录（N 次未通过）」——
   * 于是合约提取失败的记录顶着「评审记录」的名字出现在收尾 prompt 里，组长据此判断
   * 「评审根本没跑」。两个不同关卡不能共用一个字段名，评审结论现在独立落在 `reviews`。
   */
  retryNotes?: string[];
  durationMs: number;
  /** 本步执行的 session id，用于 inter-step dialog 时 resume */
  sessionId?: string;
  /** `submit_step` 的结构化交卷入参；缺省 = 本步没有按协议交卷 */
  report?: StepReport;
  /**
   * 是否按协议调了 `submit_step`。false 的步骤等于没有可信产出，
   * 组长收尾时必须看见（进「未完成项」确定性清单）。组长自执行步豁免，故为 undefined。
   */
  submitted?: boolean;
  /**
   * 每一轮评审的落档，**通过的那次也记**。
   *
   * 不记通过的那次是真实事故的直接原因：`fix` 步配了 reviewer、评审真跑了也真给了
   * `pass:true`，但引擎用完即弃，组长在收尾记录里看不到一个字，只能判「没经过 code-review」，
   * 又重新编队补跑一遍。「评审通过」与「压根没配评审人」在数据上必须可区分。
   */
  reviews?: ReviewRecord[];
  /** 从交卷入参取的结构化数据（按 produces.data 声明的字段），供下游 {{step:id.field}} 引用 */
  extractedData?: Record<string, string>;
  /** 产出合约是否满足（undefined = 无合约声明） */
  contractFulfilled?: boolean;
  /** 本步员工提出的确认项（escalate 工具），组长收尾时必须逐条表态 */
  escalations?: Escalation[];
}
