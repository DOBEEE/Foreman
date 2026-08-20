/**
 * 编队「必须交卷」回归（零 LLM，纯断言）。
 *
 * 背景（真实事故，logs/runs-2026-08-19）：`fix` 步配了 `reviewer: code-review`，评审也真跑了
 * 并给出 `{"pass":true}`，但引擎只在**评审不通过**时才把意见记进步骤记录——通过的那次
 * 一个字都不留。组长收尾时看到的画面与「压根没配评审人」完全相同，于是判定「这次修复
 * 从未经过 code-review」，又重新编队补跑一遍（idx 20→21→22、idx 43→45、idx 50→51→52）。
 *
 * 同一条链上还有第二个洞：步骤产出取的是整段流式文本，`produces.data` 只能拿这坨文本
 * 喂轻量 LLM 反向刮取，刮失手就整步重跑。
 *
 * 修复方式是给编队成员补上对组长的交卷工具 `submit_step`（员工对老板早就是「必须调工具
 * 表态，只输出文本会被拦回来重做」，编队内部一直缺这一半），并且**不拿正文兜底**。
 * 这里用假 agent 钉住语义：
 * 1. 调了工具 → 入参被捕获，产出是结构化渲染文本而不是旁白；
 * 2. 只输出文本 → 就地提醒一次，且在**原会话** resume（不让他把活重做一遍）；
 * 3. 提醒后仍不交卷 → slot 为空，调用方据此判「没有可信产出」，不静默放行；
 * 4. 评审角色的 schema 带 verdict；`produces.data` 声明的字段进 schema，由员工填。
 *
 * 用法：npx tsx server/agents/squad/__fixtures__/check-squad-submit.ts
 */

import { runWithSubmit, submitSlot, SUBMIT_NUDGE, type SquadRuntime } from "../executor.js";
import { renderStepReport, SUBMIT_STEP_TOOL, type StepReport } from "../../../tools/step-report.js";
import type { AgentEvent } from "../../../core/runner.js";

let pass = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    process.stdout.write(`  ✅ ${name}\n`);
  } else {
    fails.push(name);
    process.stdout.write(`  ❌ ${name}${detail ? `：${detail}` : ""}\n`);
  }
}

function baseRt(): SquadRuntime {
  return { leadName: "lead", cwd: "/tmp/fixture-squad-submit", baseParams: {}, depth: 0 };
}

/** 工具袋里的工具对象（Vercel inline tool 形状），夹具直接调 execute 模拟模型调用 */
interface CallableTool {
  execute: (input: unknown) => Promise<unknown>;
  inputSchema: { shape: Record<string, unknown> };
}

function toolsOf(input: Record<string, unknown>): Record<string, CallableTool> {
  return (input.params as Record<string, unknown>).__extraTools as Record<string, CallableTool>;
}

/**
 * 假 agent：按轮次脚本决定这一轮要不要调交卷工具。
 * 记下每轮收到的 brief 与 resume，用来断言「增量提醒 + 原会话续跑」。
 */
function fakeAgent(
  submitOn: (round: number) => StepReport | undefined,
  log: { briefs: string[]; resumes: (string | undefined)[] },
) {
  let round = 0;
  return {
    async *run(input: Record<string, unknown>): AsyncGenerator<AgentEvent> {
      round++;
      log.briefs.push(String(input.prompt));
      log.resumes.push(input.resume as string | undefined);
      const report = submitOn(round);
      if (report) await toolsOf(input)[SUBMIT_STEP_TOOL].execute(report);
      yield { event: "text", data: { text: "一堆过程旁白：Now let me scan the packages…" } };
      yield { event: "result", data: { subtype: "success", isError: false, sessionId: "sess-1" } };
    },
  };
}

const okReport: StepReport = {
  outcome: "done",
  conclusion: "已修复 5 处 extraText 透传",
  deliverables: "commit 783b364",
  verification: "git show 逐处复核",
  risks: "无",
  decisions: "选 allow_multiple 批量替换，先精确匹配排除已修实例",
};

process.stdout.write("\n── 调了 submit_step：入参被捕获，产出是结构化文本 ──\n");
{
  const log = { briefs: [] as string[], resumes: [] as (string | undefined)[] };
  const slot = submitSlot();
  await runWithSubmit(baseRt(), fakeAgent(() => okReport, log), "brief", {}, slot);
  const got = slot.get();
  check("交卷入参被捕获", got?.conclusion === okReport.conclusion, JSON.stringify(got));
  check("只跑了一轮（交卷了就不必提醒）", log.briefs.length === 1, String(log.briefs.length));
  const rendered = renderStepReport(okReport);
  check(
    "渲染产出含结构化字段、不含流式旁白",
    rendered.includes("**结论**") &&
      rendered.includes("commit 783b364") &&
      !rendered.includes("Now let me scan"),
    rendered,
  );
  check("风险填「无」时不占一行", !rendered.includes("**风险与遗留**"), rendered);
}

process.stdout.write("\n── 只输出文本：拦回来重做，且在原会话续跑 ──\n");
{
  const log = { briefs: [] as string[], resumes: [] as (string | undefined)[] };
  const slot = submitSlot();
  // 第 1 轮只吐文本，第 2 轮才交卷
  await runWithSubmit(
    baseRt(),
    fakeAgent((r) => (r >= 2 ? okReport : undefined), log),
    "原始 brief",
    {},
    slot,
  );
  check("提醒后拿到了交卷入参", slot.get()?.conclusion === okReport.conclusion);
  check("总共跑了两轮", log.briefs.length === 2, String(log.briefs.length));
  check("第二轮发的是增量提醒，不是整段 brief 重发", log.briefs[1] === SUBMIT_NUDGE, log.briefs[1]);
  check("第二轮在原会话 resume", log.resumes[1] === "sess-1", JSON.stringify(log.resumes));
}

process.stdout.write("\n── 提醒后仍不交卷：不拿正文兜底 ──\n");
{
  const log = { briefs: [] as string[], resumes: [] as (string | undefined)[] };
  const slot = submitSlot();
  const result = await runWithSubmit(baseRt(), fakeAgent(() => undefined, log), "brief", {}, slot);
  check("slot 为空（调用方据此判未完成）", slot.get() === undefined);
  check("只提醒一次就收手，不无限重试", log.briefs.length === 2, String(log.briefs.length));
  check(
    "正文旁白仍在返回值里，但不会被当成产出",
    result.text.includes("Now let me scan"),
    result.text,
  );
}

process.stdout.write("\n── schema 按角色/合约动态生成 ──\n");
{
  const worker = submitSlot().tool as CallableTool;
  const reviewer = submitSlot({ reviewer: true }).tool as CallableTool;
  const withData = submitSlot({ dataFields: { branch: "分支名", testCommand: "验证命令" } })
    .tool as CallableTool;
  check("执行者 schema 无 verdict", !("verdict" in worker.inputSchema.shape));
  check("评审人 schema 有 verdict", "verdict" in reviewer.inputSchema.shape);
  check("声明了 produces.data 时 schema 带 data", "data" in withData.inputSchema.shape);
  check("未声明 produces.data 时不带 data", !("data" in worker.inputSchema.shape));
}

process.stdout.write("\n── 合约字段由员工填、不再反向刮取 ──\n");
{
  const slot = submitSlot({ dataFields: { branch: "分支名" } });
  const log = { briefs: [] as string[], resumes: [] as (string | undefined)[] };
  await runWithSubmit(
    baseRt(),
    fakeAgent(() => ({ ...okReport, data: { branch: "feat/1.0.1817" } }), log),
    "brief",
    {},
    slot,
  );
  check("data 字段随交卷入参一起拿到", slot.get()?.data?.branch === "feat/1.0.1817");
  check(
    "渲染时把关键信息也带给组长",
    renderStepReport(slot.get()!).includes("branch=feat/1.0.1817"),
    renderStepReport(slot.get()!),
  );
}

process.stdout.write(
  fails.length === 0
    ? `\n━━━ ${pass}/${pass} 通过 ━━━\n`
    : `\n━━━ ${pass}/${pass + fails.length} 通过，失败：${fails.join("、")} ━━━\n`,
);
if (fails.length > 0) process.exitCode = 1;
