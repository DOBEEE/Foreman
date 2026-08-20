import { contractViolationsOf, traceEventsOf } from "../harvest-sweep.js";
import { matchDeterministicIntent } from "../../boss/intent.js";
import type { TraceRecord } from "../logger.js";

/**
 * 采集扫描与审批意图的确定性断言。
 *
 * 不跑 sweepHarvest 全流程（那要真实日志目录与岗位配置），只锁住两处最容易错的判断：
 * trace 事件的配对还原，和「批准用例」不能被「批准提案」的正则吃掉。
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

process.stdout.write("\n── trace 事件还原 ──\n");
{
  const record = {
    runId: "r1",
    time: "2026-08-11T00:00:00.000Z",
    agent: "assistant",
    prompt: "问题",
    isError: false,
    events: [
      { seq: 0, t: 1, type: "text", text: "我查一下" },
      { seq: 1, t: 2, type: "tool_call", id: "t1", name: "Grep", input: { pattern: "x" } },
      { seq: 2, t: 3, type: "tool_result", toolUseId: "t1", isError: false, content: "hit" },
      { seq: 3, t: 4, type: "tool_call", id: "t2", name: "Read", input: { file_path: "/a" } },
      { seq: 4, t: 5, type: "tool_result", toolUseId: "ghost", isError: true, content: "orphan" },
    ],
  } as TraceRecord;

  const events = traceEventsOf(record);
  check("只有工具调用变成断言事件", events.length === 2, `${events.length} 个`);
  check("结果按 toolUseId 回填", (events[0].result as { content?: unknown })?.content === "hit");
  check("没拿到结果的调用保留 result:null", events[1].result === null);
  check("孤儿结果不凭空造事件（否则 scope 会误判）", events.every((e) => e.id !== "ghost"));
  check("sequence 用 trace 的 seq，order 断言才判得准", events[0].sequence === 1 && events[1].sequence === 3);
}

process.stdout.write("\n── 契约违规检出 ──\n");
{
  // judge 是内置只读岗位（tools 只有 Read/Glob/Grep），拿它当被测对象最稳定
  const base = {
    runId: "r2",
    time: "2026-08-11T00:00:00.000Z",
    agent: "judge",
    prompt: "判一下",
    isError: false,
  };
  const clean = contractViolationsOf({
    ...base,
    events: [{ seq: 0, t: 1, type: "tool_call", id: "t1", name: "Read", input: {} }],
  } as TraceRecord);
  // 只读岗位规规矩矩只 Read，唯一可能失败的是 READ-SCOPE（入参没路径 → not_applicable）
  check("守规矩的执行没有违规", clean.length === 0, clean.join(","));

  const dirty = contractViolationsOf({
    ...base,
    events: [{ seq: 0, t: 1, type: "tool_call", id: "t1", name: "Write", input: {} }],
  } as TraceRecord);
  check("只读岗位出现 Write 被检出", dirty.includes("CONTRACT-READONLY"), dirty.join(","));
  check("白名单外的调用也被检出", dirty.includes("CONTRACT-TOOLS"), dirty.join(","));

  const missing = contractViolationsOf({ ...base, agent: "不存在的岗位", events: [] } as TraceRecord);
  check("岗位不存在时不臆造违规", missing.length === 0);
}

process.stdout.write("\n── 审批意图不串台 ──\n");
{
  const seg = (text: string) => matchDeterministicIntent(text, [])?.segments[0];

  const approveCase = seg("批准用例 assistant-1a2b3c4d");
  check(
    "「批准用例 <id>」走 case 而不是提案",
    approveCase?.kind === "case_op" && approveCase.op === "approve",
    `${approveCase?.kind}/${(approveCase as { op?: string })?.op}`,
  );
  check(
    "caseId 完整传下去（含岗位前缀）",
    (approveCase as { caseRef?: string })?.caseRef === "assistant-1a2b3c4d",
  );

  const discardCase = seg("驳回用例 assistant-1a2b3c4d");
  check("「驳回用例 <id>」走 case", discardCase?.kind === "case_op" && discardCase.op === "discard");

  const listCase = seg("待审用例");
  check("「待审用例」列 case 清单", listCase?.kind === "case_op" && listCase.op === "list");

  // 提案审批必须完全不受影响
  const applyProposal = seg("批准 20260811-assistant");
  check(
    "裸「批准 <id>」仍然是提案",
    applyProposal?.kind === "proposal_op" && applyProposal.op === "apply",
    `${applyProposal?.kind}`,
  );
  const listProposal = seg("待审提案");
  check("「待审提案」仍列提案", listProposal?.kind === "proposal_op" && listProposal.op === "list");
  const rejectProposal = seg("驳回 20260811-assistant");
  check("裸「驳回 <id>」仍然是提案", rejectProposal?.kind === "proposal_op" && rejectProposal.op === "reject");

  check("「/cases」也能列 case", seg("/cases")?.kind === "case_op");
  check("普通消息不被吞掉", seg("帮我看看这个报错") === undefined);
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
