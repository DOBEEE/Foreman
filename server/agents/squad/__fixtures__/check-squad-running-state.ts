/**
 * 编队「当前在跑的步骤」上报回归（零 LLM，纯断言）。
 *
 * 背景：组织图（web/src/pages/OrgChart.tsx）早先拿 boss 任务态去判断编队成员在不在忙，
 * 但编队步骤走 runDelegate 直接跑 agent、**不建 boss Task**，于是那个判据恒为 false ——
 * 队长派完活后连线与徽标整簇消失。修复方式是让执行器把「谁在跑哪一步」上报给组长落盘，
 * 看板改读这份状态。
 *
 * 这里钉住上报语义（组长侧的持久化逻辑用同样的写/清规则在本文件内模拟）：
 * 1. 每步开工都上报 role=exec，且 stepId / employee 与计划一致、顺序与计划一致；
 * 2. onStepDone 与 onStepRunning 成对出现（每步先 running 后 done）；
 * 3. 编队跑完后 running 必须已被清空 —— 否则看板会把结束的编队一直画成进行中，
 *    正是修复前后都要避免的假象。
 *
 * 用法：npx tsx server/agents/squad/__fixtures__/check-squad-running-state.ts
 */

import { executeTeamPlan, type RunningStep, type SquadRuntime } from "../executor.js";
import type { TeamPlan } from "../types.js";

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

/**
 * 全部步骤都指定 employee="lead"：走 runLeadStep 回调，不碰 registry 也不碰模型。
 * 不给 accept / produces / reviewer，避免触发需要 LLM 的验收与评审分支。
 */
const plan: TeamPlan = {
  goal: "验证 running 上报",
  steps: [
    { id: "s1", title: "第一步", employee: "lead", brief: "做 s1" },
    { id: "s2", title: "第二步", employee: "lead", brief: "做 s2" },
  ],
};

/** 组长侧持久化的模拟：onStepRunning 写、onStepDone 按 stepId 清（与 lead.agent.ts 一致） */
let persisted: RunningStep | undefined;
const timeline: string[] = [];
const reported: RunningStep[] = [];

const rt: SquadRuntime = {
  leadName: "lead",
  cwd: "/tmp/fixture-squad-running",
  baseParams: {},
  depth: 0,
  runLeadStep: async () => {
    // 步骤执行期间：看板此刻应该能看到有人在跑
    timeline.push(`run:${persisted?.stepId ?? "none"}`);
    return "done";
  },
  onStepRunning: (r) => {
    reported.push(r);
    persisted = r;
    timeline.push(`running:${r.stepId}:${r.role}:${r.employee}`);
  },
  onStepDone: (o) => {
    if (persisted?.stepId === o.id) persisted = undefined;
    timeline.push(`done:${o.id}`);
  },
};

const outcomes: unknown[] = [];
const gen = executeTeamPlan(rt, plan, { prompt: "go" });
let next = await gen.next();
while (!next.done) next = await gen.next();
outcomes.push(...next.value);

check("两步都上报了开工", reported.length === 2, `实际 ${reported.length} 次`);
check(
  "上报的 stepId 与顺序跟计划一致",
  reported.map((r) => r.stepId).join(",") === "s1,s2",
  reported.map((r) => r.stepId).join(","),
);
check(
  "执行阶段 role=exec、employee 取自计划",
  reported.every((r) => r.role === "exec" && r.employee === "lead"),
  JSON.stringify(reported),
);
check(
  "每步先 running 再 done",
  timeline.join("|") ===
    "running:s1:exec:lead|run:s1|done:s1|running:s2:exec:lead|run:s2|done:s2",
  timeline.join("|"),
);
check("跑完后 running 已清空（看板不会误报进行中）", persisted === undefined, String(persisted));
check("两步都产出了 outcome", outcomes.length === 2, `实际 ${outcomes.length}`);

process.stdout.write(
  fails.length === 0
    ? `\n━━━ ${pass}/${pass} 通过 ━━━\n`
    : `\n━━━ ${pass}/${pass + fails.length} 通过，失败：${fails.join("、")} ━━━\n`,
);
if (fails.length > 0) process.exitCode = 1;
