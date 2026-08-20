/**
 * 回归门禁的操作台（零 LLM）。
 *
 * 分两层，回答的是两个不同的问题：
 *
 *   一层 · gate tier1 —— 「同样的问题会不会再犯」。确定性断言翻转，不启任何 judge，
 *   所以整个「基线轮 → 挂候选 → 候选轮 → 摘候选」循环就在本进程内跑完，一条命令。
 *
 *   二层 · gate stage/attach —— 「是不是变笨了」。四维 LLM 判定，成本高、要基线和噪声带，
 *   证据必须带外产出，所以拆成 stage / attach 两步，中途失败可以从任一步重来。
 *
 *   gate tier1 <id>                   一层：跑完并回填证据（推荐先跑这个）
 *   gate stage <id>                   把候选提示词临时挂到员工身上
 *   （在 agent-bench 里跑二层回归，产出 campaign.json）
 *   gate attach <id> <campaign.json>  生成二层证据回填提案，并自动摘下候选
 *   gate status <id>                  看当前证据与判定
 *
 * 二层刻意不在这里代跑：它在另一个仓库、有自己的 suite/engine 参数，
 * 把路径写死在这边只会让两个仓库的版本互相绑死。
 */
import {
  attachAssertionEvidence,
  attachRegressionEvidence,
  getProposal,
  stageCandidatePrompt,
  unstageCandidatePrompt,
} from "../boss/proposals.js";
import { benchTargetOf, buildRegressionEvidence, checkAttachedEvidence } from "../core/regression-gate.js";
import {
  buildAssertionEvidence,
  checkAssertionEvidence,
  snapshotAssertions,
} from "../core/assertion-gate.js";
import { loadRegressionCases, runRegression } from "../bench/regression.js";
import { withBenchLock } from "../core/bench-lock.js";

export const GATE_HELP = `foreman gate — 回归门禁操作台

用法:
  foreman gate tier1 <提案号>                 跑一层回归（零 LLM）：基线轮 → 挂候选 → 候选轮 → 摘候选 → 回填证据
  foreman gate stage <提案号>                 把候选提示词临时挂到员工身上（之后去跑二层回归）
  foreman gate attach <提案号> <campaign.json> 生成二层回归证据回填提案，并自动摘下候选
  foreman gate unstage <提案号>               只摘下候选、还原成提案前的版本
  foreman gate status <提案号>                查看已附的证据与门禁判定
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireProposal(id: string | undefined) {
  if (!id) fail("缺少提案号。用法见 foreman gate --help");
  const p = getProposal(id);
  if (!p) fail(`没有找到提案 ${id}`);
  return p;
}

export async function runGateCommand(argv: string[]): Promise<void> {
  const [action, id, arg] = argv;

  if (!action || action === "-h" || action === "--help") {
    console.log(GATE_HELP);
    return;
  }

  if (action === "tier1") {
    const p = requireProposal(id);
    const cases = loadRegressionCases(p.agentId);
    if (!cases.length) {
      fail(
        `${p.agentId} 还没有任何已晋升的回归 case，一层无从判定。` +
          `\n先让采集器攒够 case（需负反馈或契约违规复现 ≥2 次），并批准待审 case`,
      );
    }
    if (!p.targetAssertions?.length) {
      // 不直接失败：没声明目标时仍值得跑一轮，至少能确认「没弄坏别的」。
      // 但判定会是 no_target 且不放行——无法验证效果的改动不该生效。
      console.warn(
        "提案没声明 targetAssertions，本次只能验证「未破坏既有断言」，门禁不会放行。" +
          "\n让优化师把它要修的 finding（caseId + assertionId）写进提案。",
      );
    }

    const locked = await withBenchLock(async () => {
      console.log(`基线轮：${cases.length} 个 case（当前生效的提示词）…`);
      const before = snapshotAssertions(await runRegression({ agentId: p.agentId, cases }));

      const staged = stageCandidatePrompt(p.id);
      console.log(staged.message);
      if (!staged.ok) return undefined;
      try {
        console.log("候选轮：同一批 case（候选提示词已挂上）…");
        const after = snapshotAssertions(await runRegression({ agentId: p.agentId, cases }));
        return { before, after };
      } finally {
        // 无论候选轮成功还是抛错，候选提示词都不能留在员工身上——
        // 真正生效只能走「批准」，测量过程绝不留副作用
        console.log(unstageCandidatePrompt(p.id).message);
      }
    });

    if (!locked.ok) fail(locked.message);
    if (!locked.value) fail("挂候选提示词失败，未产出证据");

    const { evidence, verdict } = buildAssertionEvidence({
      proposedPrompt: p.after ?? "",
      before: locked.value.before,
      after: locked.value.after,
      targets: p.targetAssertions ?? [],
    });
    console.log(`\n判定：${verdict.status} — ${verdict.reason}`);
    if (verdict.fixed.length) console.log(`修好：${verdict.fixed.join(", ")}`);
    if (verdict.broken.length) console.log(`弄坏：${verdict.broken.join(", ")}`);

    const attached = attachAssertionEvidence(p.id, evidence);
    console.log(attached.message);
    if (!attached.ok) process.exit(1);
    const gate = checkAssertionEvidence(evidence, p.after ?? "");
    console.log(gate.allow ? `\n一层放行，可以批准提案 ${p.id}` : `\n一层不放行：${gate.reason}`);
    return;
  }

  if (action === "stage") {
    const p = requireProposal(id);
    const result = stageCandidatePrompt(p.id);
    console.log(result.message);
    if (!result.ok) process.exit(1);
    const { suiteId, profileId } = benchTargetOf(p.agentId);
    console.log(
      `\n接下来在 agent-bench 里跑这个 suite 的回归（3 次串行），产出 campaign.json：` +
        `\n  suite=${suiteId}  engine=${profileId}` +
        `\n跑完回来执行：\n  foreman gate attach ${p.id} <campaign.json>`,
    );
    return;
  }

  if (action === "unstage") {
    const p = requireProposal(id);
    const result = unstageCandidatePrompt(p.id);
    console.log(result.message);
    if (!result.ok) process.exit(1);
    return;
  }

  if (action === "attach") {
    const p = requireProposal(id);
    if (!arg) fail("缺少 campaign.json 路径。用法见 foreman gate --help");
    const { evidence, verdict } = buildRegressionEvidence({
      agentId: p.agentId,
      proposedPrompt: p.after ?? "",
      campaignFile: arg,
    });
    console.log(`判定：${verdict.status} — ${verdict.reason}`);
    if (verdict.deltas) console.log(`各维度变化：${JSON.stringify(verdict.deltas)}`);
    if (!evidence) {
      // 连证据都产不出来（缺基线/报告读不了）：候选还挂着，别摘——
      // 修掉原因后可以直接重跑回归，不用从 stage 重来
      fail("没能产出可用的回归证据，候选提示词仍挂着；修掉上面的原因后重跑回归再 attach");
    }
    const attached = attachRegressionEvidence(p.id, evidence);
    console.log(attached.message);
    if (!attached.ok) process.exit(1);
    // 证据已经落盘，候选没有继续挂着的理由；真正生效走「批准」
    const restored = unstageCandidatePrompt(p.id);
    console.log(restored.message);
    const gate = checkAttachedEvidence(evidence, p.after ?? "");
    console.log(
      gate.allow
        ? `\n门禁放行，现在可以批准提案 ${p.id}`
        : `\n门禁仍不放行：${gate.reason}`,
    );
    return;
  }

  if (action === "status") {
    const p = requireProposal(id);
    if (p.assertionGate) {
      console.log("── 一层（断言翻转，零 LLM）──");
      console.log(JSON.stringify(p.assertionGate, null, 2));
      const tier1 = checkAssertionEvidence(p.assertionGate, p.after ?? "");
      console.log(tier1.allow ? "一层：放行" : `一层：拦截 — ${tier1.reason}`);
    } else if (p.targetAssertions?.length) {
      console.log(`一层：还没有证据。先跑 foreman gate tier1 ${p.id}`);
    }
    if (!p.regression) {
      console.log(`\n二层：还没有证据。先跑 gate stage ${p.id}`);
      return;
    }
    console.log("\n── 二层（四维 LLM 判定）──");
    console.log(JSON.stringify(p.regression, null, 2));
    const gate = checkAttachedEvidence(p.regression, p.after ?? "");
    console.log(gate.allow ? "二层：放行" : `二层：拦截 — ${gate.reason}`);
    return;
  }

  fail(`未知的 gate 子命令：${action}\n\n${GATE_HELP}`);
}
