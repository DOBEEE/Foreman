/**
 * 验收护栏的结构性校验（零 LLM，纯断言）。
 *
 * 为什么必须专测：验收从「只在员工不交卷时兜底」改成了**全量**，于是每个任务都要过这一关。
 * 一旦护栏失效，坏的不是某个任务而是整条流水线：
 * - fail-closed 对交卷路径同样生效 → 一次网关 429 就把已交付的活播报成「未通过验收」，
 *   再烧两轮追问；更糟的是 retro/optimizer 也走交卷路径，误判会让 schedule 的 failCount
 *   累加到阈值后**自动停用定时任务**，验收抖动被放大成「定时任务静默消失」。
 * - 交卷路径放开 needs_user → 员工已经显式交卷了，验收环节却凭空升级去打扰用户。
 * - 硬校验没接上 → 员工说「已写入 x.md」而文件不在，照样判通过（实测反复出现过）。
 *
 * 本文件用 stub 顶掉模型调用，只验判定与降级路径。
 * 用法：npx tsx server/boss/__fixtures__/check-review-guard.ts
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRuntime } from "../../runtime/index.js";
import { missingContractFiles } from "../../core/contract.js";
import { reviewEmployeeOutput } from "../review.js";
import { loadReportStyle, pickDeliveryText } from "../report-style.js";

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

/** 假 runtime：记录看到的 prompt，并按开关返回预设文本或抛错，完全不碰网络 */
let reply = '{"status":"completed","summary":"结论：干完了"}';
let boom: string | undefined;
let completeCalls = 0;
let seenPrompt = "";

function installFakeRuntime(): void {
  setRuntime({
    async complete(input: { prompt: string }) {
      completeCalls++;
      seenPrompt = input.prompt;
      if (boom) throw new Error(boom);
      return { text: reply, isError: false };
    },
    // 本 fixture 只用 complete；run 不会被触达
    run() {
      throw new Error("不该被调用");
    },
  } as never);
}

const ROOT = join(tmpdir(), `ait-review-fixture-${process.pid}`);

async function main(): Promise<void> {
  installFakeRuntime();
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "report.md"), "x");

  const review = (
    output: string,
    opts: Parameters<typeof reviewEmployeeOutput>[4] = {},
  ) => reviewEmployeeOutput("小测", "把事情做完", output, {}, opts);

  process.stdout.write("\n── 硬校验优先于模型：缺产出直接判失败且零调用 ──\n");
  completeCalls = 0;
  const missing = missingContractFiles({ files: ["nope.md"] }, ROOT);
  const hard = await review("我已经写好 nope.md 了", { submitted: true, contractMissing: missing });
  check("判 failed", hard.status === "failed", hard.status);
  check("一次模型都没调", completeCalls === 0, String(completeCalls));
  check("汇报里点明缺什么", Boolean(hard.summary?.includes("nope.md")), hard.summary);
  check(
    "说明是实际核查而非判断（用户要能分辨）",
    Boolean(hard.summary?.includes("文件系统")),
    hard.summary,
  );

  completeCalls = 0;
  const ok = await review("写完了", {
    submitted: true,
    contractMissing: missingContractFiles({ files: ["report.md"] }, ROOT),
  });
  check("产出都在时不拦，交给模型判", ok.status === "completed" && completeCalls === 1);

  process.stdout.write("\n── 交卷路径：禁止 needs_user ──\n");
  reply = '{"status":"needs_user","question":"你要哪个方案？"}';
  const submitted = await review("报告：已产出 x", { submitted: true });
  check(
    "模型给了 needs_user 也按通过处理（他要问用户会用提问工具）",
    submitted.status === "completed",
    submitted.status,
  );
  const notSubmitted = await review("我需要你确认一下用哪个方案");
  check("非交卷路径仍接受 needs_user", notSubmitted.status === "needs_user", notSubmitted.status);
  check("并且带着问题原文", notSubmitted.question === "你要哪个方案？");

  process.stdout.write("\n── 非对称 fail-closed（这条护着定时任务不被自动停用）──\n");
  boom = "[429] too many requests";
  const submitBoom = await review("报告：已产出 x", { submitted: true });
  check(
    "交卷路径遇基础设施异常 → 回落通过",
    submitBoom.status === "completed",
    `${submitBoom.status}：否则 retro/optimizer 会被刷到 failCount 阈值而自动停用`,
  );
  const fallbackBoom = await review("一段没交卷的输出");
  check(
    "非交卷路径仍 fail-closed",
    fallbackBoom.status === "failed",
    "员工没交卷时，验收自己挂了不代表他干完了",
  );
  check("并说明是验收环节出错", Boolean(fallbackBoom.summary?.includes("验收环节")), fallbackBoom.summary);
  boom = undefined;

  process.stdout.write("\n── 验收标准作为独立段落进提示词 ──\n");
  reply = '{"status":"completed","summary":"ok"}';
  seenPrompt = "";
  await review("产出", { submitted: true, acceptance: "必须给出压测的 P99 数字" });
  check("验收标准出现在提示词里", seenPrompt.includes("必须给出压测的 P99 数字"));
  check("而且是独立段落、要求逐条核对", seenPrompt.includes("验收标准"), "混在自由文本里没人当依据");
  check(
    "交卷路径的输出契约里没有 needs_user",
    !seenPrompt.includes('"status":"completed|needs_user|failed"'),
  );

  seenPrompt = "";
  await review("产出");
  check("非交卷路径的输出契约保留 needs_user", seenPrompt.includes("needs_user"));

  process.stdout.write("\n── 非法输出仍走各自的降级 ──\n");
  reply = "这不是 JSON";
  const badSubmit = await review("产出", { submitted: true });
  check("交卷路径：解析失败也回落通过", badSubmit.status === "completed", badSubmit.status);
  const badFallback = await review("产出");
  check("非交卷路径：解析失败判失败", badFallback.status === "failed", badFallback.status);

  process.stdout.write("\n── 汇报风格：规则注入 + 不再下发固定模板 ──\n");
  reply = '{"status":"completed","summary":"修好了。根因 X，commit abc123 已推 feat/1.0"}';
  seenPrompt = "";
  await review("产出", { submitted: true });
  const style = loadReportStyle();
  check("汇报风格手册被注入 prompt", seenPrompt.includes(style.slice(0, 40)), style.slice(0, 40));
  check(
    "结构与长度授权给模型自己判断",
    seenPrompt.includes("结构和长度由你自己判断"),
    "缺少授权，模型会退回套模板",
  );
  check(
    "旧的固定四段式已移除",
    !seenPrompt.includes("交付物：文件/分支/命令等，逐条列出"),
    "固定模板仍在 prompt 里",
  );
  check(
    "事实锚定约束仍在（坐标一字不改）",
    seenPrompt.includes("一字不改"),
    "丢了「路径/commit 一字不改」的约束，摘要就可能把 commit 总结掉",
  );

  process.stdout.write("\n── 发给用户的文字：优先 summary，缺失才回落模板 ──\n");
  check(
    "有 summary 就发 summary",
    pickDeliveryText("修好了。根因 X", "**任务汇报**\n- **结论**：…") === "修好了。根因 X",
  );
  check(
    "summary 空白回落交卷模板（绝不发空）",
    pickDeliveryText("   ", "**任务汇报**") === "**任务汇报**",
  );
  check("summary 缺失同样回落", pickDeliveryText(undefined, "**任务汇报**") === "**任务汇报**");

  rmSync(ROOT, { recursive: true, force: true });
  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

void main();
