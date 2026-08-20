/**
 * 答复归属回归（零 LLM，纯断言）。
 *
 * 背景（线上事故 #50b0e6 / #de2f8e）：每日复盘（retro）任务挂 waiting_user 等用户拍板，
 * 用户回复后 boss 正确调了 answer_employee_question，但答复被**重路由**给了 hr——
 * 因为 opAnswerEmployeeQuestion 曾用 `!task.sessionId` 判「澄清占位任务」，而 retro 的子
 * 会话 persistSession:false、任务从不带 sessionId，于是真跑过的复盘任务被误判成占位、
 * 走了重路由分支；而重路由候选池排除了 manualOnly 的 retro、包含 hr，答复永远回不到复盘员。
 *
 * 这里钉住修复后的不变量：只有显式标了 awaitingClarifyRoute 的占位任务才重路由，
 * 其余任何 waiting_user 任务（含无 sessionId 的 retro）的答复都回到它自己的员工。
 *
 * 用法：npx tsx server/boss/__fixtures__/check-answer-routing.ts
 */

import { shouldRerouteAnswer } from "../boss.js";
import type { Task } from "../types.js";

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

function main(): void {
  process.stdout.write("\n── 只有澄清占位任务才重路由 ──\n");

  // 事故复现：retro 复盘任务真跑过、但无 sessionId，也不是占位。绝不能重路由。
  const retroWaiting: Pick<Task, "awaitingClarifyRoute"> = {};
  check(
    "无 sessionId 的 retro 复盘任务 → 不重路由（答复回到复盘员，不落 hr）",
    shouldRerouteAnswer(retroWaiting) === false,
  );

  // 澄清占位任务：从未派发过员工，等用户定向。这是唯一该重路由的场景。
  const clarifyPlaceholder: Pick<Task, "awaitingClarifyRoute"> = { awaitingClarifyRoute: true };
  check(
    "澄清占位任务（awaitingClarifyRoute=true） → 重路由（保留原有行为）",
    shouldRerouteAnswer(clarifyPlaceholder) === true,
  );

  // 普通在办任务（有 sessionId、非占位）：答复 resume 回自己的员工。
  const normalRan: Pick<Task, "awaitingClarifyRoute"> = { awaitingClarifyRoute: false };
  check(
    "普通在办任务 → 不重路由",
    shouldRerouteAnswer(normalRan) === false,
  );

  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

main();
