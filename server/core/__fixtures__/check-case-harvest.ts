/**
 * case 自动采集的判据断言（零 LLM）。
 *
 * 为什么必须先钉死判据：采集器决定「什么会成为永久评测标准」。一条错采的 case 会让
 * 正确行为被持续判失败，而优化师会照着这个「客观证据」把员工改坏——而且每一步都有据可依。
 * 这是整条自进化链路里最危险的失效形态，所以判据本身要先可证伪。
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseIdFor, harvestCase, harvestRoots, isInfrastructureFailure, approveHarvestedCase } from "../case-harvest.js";
import { loadRegressionCases } from "../../bench/regression.js";
import type { TraceRecord } from "../logger.js";
import type { FeedbackRecord } from "../feedback.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

/** 每个场景用独立的 runId，避免 provenance 去重把复现计数吃掉 */
let seq = 0;
const trace = (over: Partial<TraceRecord> = {}): TraceRecord => ({
  runId: `run-${++seq}`,
  time: new Date().toISOString(),
  agent: "judge",
  prompt: "读取 probe.json 并返回 ping 字段",
  isError: true,
  error: "boom",
  events: [],
  ...over,
});

const negative: FeedbackRecord = {
  time: new Date().toISOString(),
  chatId: "c1",
  polarity: "negative",
  signal: "explicit",
  text: "答错了，应该只填 BASE_URL 和 AUTH_TOKEN",
};

// 采集写的是 <runtimeDir>/bench，fixture 跑完清掉自己造的目录
const roots = harvestRoots();
const cleanup: string[] = [];

process.stdout.write("\n── 基础设施故障一律不采 ──\n");
{
  check("model_gateway 判为基础设施故障", isInfrastructureFailure({ errorSource: "model_gateway" }));
  check("retryable 判为基础设施故障", isInfrastructureFailure({ retryable: true }));
  check("runtime 且不可重试不算", !isInfrastructureFailure({ errorSource: "runtime", retryable: false }));

  const limited = harvestCase(trace({ errorSource: "model_gateway", error: "[500] too many requests" }), negative);
  check("限流即使带负反馈也不采", limited.action === "skipped", JSON.stringify(limited));
  const flaky = harvestCase(trace({ retryable: true, error: "fetch failed" }), negative);
  check("可重试的瞬时失败不采", flaky.action === "skipped", JSON.stringify(flaky));
}

process.stdout.write("\n── 内容寻址与幂等 ──\n");
{
  const a = caseIdFor("judge", "同一个问题", []);
  const b = caseIdFor("judge", "  同一个问题  ", []);
  check("首尾空白不影响 caseId（跨实例可收敛）", a === b, `${a} vs ${b}`);
  check("caseId 带岗位前缀", a.startsWith("judge-"), a);
  check("不同岗位不同 caseId", caseIdFor("coder", "同一个问题", []) !== a);
}

process.stdout.write("\n── 契约违规：客观，无需人审 ──\n");
{
  const first = harvestCase(trace({ errorSource: "runtime" }));
  check("首次只进 candidates", first.action === "candidate", JSON.stringify(first));
  check("首次复现计数为 1", first.action === "candidate" && first.reproductions === 1);
  check("契约类不需要人审", first.action === "candidate" && first.needsApproval === false);

  const second = harvestCase(trace({ errorSource: "runtime" }));
  check("复现 2 次后自动晋升", second.action === "promoted", JSON.stringify(second));
  if (second.action === "promoted") {
    const dir = join(roots.cases, "judge", second.caseId);
    cleanup.push(dir, join(roots.candidates, "judge", second.caseId));
    check("产出 case.json", existsSync(join(dir, "case.json")));
    check("产出 input/prompt.md", existsSync(join(dir, "input", "prompt.md")));
    check("产出封存的 oracle/trace.json", existsSync(join(dir, "oracle", "trace.json")));
    const oracle = JSON.parse(readFileSync(join(dir, "oracle", "trace.json"), "utf-8"));
    check("oracle 里有派生断言", Array.isArray(oracle.assertions) && oracle.assertions.length > 0);
    const saved = JSON.parse(readFileSync(join(dir, "case.json"), "utf-8"));
    check("溯源记录了两次 runId", saved.provenance.runIds.length === 2, JSON.stringify(saved.provenance.runIds));
    check("来源标为契约违规", saved.source === "contract_violation", saved.source);
    check("candidates 里的副本已清理", !existsSync(join(roots.candidates, "judge", second.caseId)));
  }
}

process.stdout.write("\n── 用户负反馈：引入新标准，必须人审 ──\n");
{
  const prompt = "走代理时鉴权变量怎么填";
  const first = harvestCase(trace({ prompt, errorSource: "runtime" }), negative);
  const second = harvestCase(trace({ prompt, errorSource: "runtime" }), negative);
  check("复现两次后仍留在 candidates", second.action === "candidate", JSON.stringify(second));
  check("标记需要人审", second.action === "candidate" && second.needsApproval === true);
  if (second.action === "candidate") {
    const candidateDir = join(roots.candidates, "judge", second.caseId);
    cleanup.push(candidateDir, join(roots.cases, "judge", second.caseId));
    const saved = JSON.parse(readFileSync(join(candidateDir, "case.json"), "utf-8"));
    check("保留了用户反馈原话供核对", saved.provenance.feedbackText?.includes("BASE_URL") === true);
    check("来源标为用户反馈", saved.source === "user_feedback", saved.source);

    const approved = approveHarvestedCase("judge", second.caseId);
    check("批准后晋升", approved.ok, approved.message);
    check("晋升后进 cases", existsSync(join(roots.cases, "judge", second.caseId, "case.json")));
    check("批准提示会让基线失效", approved.message.includes("基线"), approved.message);
  }
  check("批准不存在的 case 会报错", !approveHarvestedCase("judge", "judge-nope").ok);
}

process.stdout.write("\n── 复现不足不许固化 ──\n");
{
  const prompt = "只出现过一次的问题";
  const once = harvestCase(trace({ prompt, errorSource: "runtime" }), negative);
  if (once.action === "candidate") {
    cleanup.push(join(roots.candidates, "judge", once.caseId));
    const denied = approveHarvestedCase("judge", once.caseId);
    // 一次性抖动不该变成永久标准
    check("只复现 1 次时拒绝批准", !denied.ok, denied.message);
    check("拒绝理由点明复现次数", denied.message.includes("复现"), denied.message);
  } else {
    check("只复现 1 次时应留在 candidates", false, JSON.stringify(once));
  }
}

process.stdout.write("\n── 晋升的 case 必须能被回归 runner 读回来 ──\n");
{
  // 这是两个模块之间的格式契约：writeCaseDir 写、loadRegressionCases 读。
  // 对不上不会报错，只会「加载到 0 条 case」静默空跑——回归套件看起来永远全绿。
  const prompt = "跨模块格式契约用例";
  harvestCase(trace({ prompt, errorSource: "runtime" }), negative);
  const ready = harvestCase(trace({ prompt, errorSource: "runtime" }), negative);
  if (ready.action !== "candidate") {
    check("第二次复现应进 candidates", false, JSON.stringify(ready));
  } else {
    cleanup.push(join(roots.candidates, "judge", ready.caseId), join(roots.cases, "judge", ready.caseId));
    check("批准晋升", approveHarvestedCase("judge", ready.caseId).ok);
    const loaded = loadRegressionCases("judge").find((item) => item.caseId === ready.caseId);
    check("runner 能加载到这条 case", loaded !== undefined);
    check("提问原文一致", loaded?.prompt === prompt, loaded?.prompt);
    check(
      "断言从封存的 oracle 读出（不是空数组）",
      (loaded?.assertions.length ?? 0) > 0,
      `${loaded?.assertions.length} 条`,
    );
    check("来源一并带出，报告里要显示", loaded?.source === "user_feedback", loaded?.source);
  }
}

for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
