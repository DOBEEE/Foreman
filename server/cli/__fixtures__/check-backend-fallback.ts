import { startLocalBackend } from "../backend.js";

/**
 * 内嵌 backend 的端口回退断言。
 *
 * 为什么值得一个 fixture：单命令合并后交互式 CLI 会去绑固定端口，「多开一个终端」
 * 从不可能变成了日常。这条路上有两个只在真跑时才暴露的坑：
 *   1. 被占时必须回退而不是退出 —— 第二个终端起不来是回归
 *   2. 回退是**常规事件**，监听失败的处理不能留下没人接的 rejection
 *      （旧实现用 Promise.race，输掉的那个 error 监听会挂着，crash-guard 会报假崩溃）
 * 同时守住反向语义：守护进程不开回退，必须硬失败。
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

// 没人接的 rejection 会被这里抓到 —— 回退路径一旦留下悬挂 promise，这个 fixture 就红
let unhandled = "";
process.on("unhandledRejection", (reason) => {
  unhandled = reason instanceof Error ? reason.message : String(reason);
});

const FIXED = 34567;

process.stdout.write("\n── 固定端口被占时回退 ──\n");
const a = await startLocalBackend({ port: FIXED, host: "127.0.0.1", fallbackToRandomPort: true });
check("首个实例拿到请求的固定端口", a.port === FIXED, `port=${a.port}`);
check("未发生回退", a.fellBack === false);

const b = await startLocalBackend({ port: FIXED, host: "127.0.0.1", fallbackToRandomPort: true });
check("第二个实例仍能起来（不抛错、不退出）", b.port > 0, `port=${b.port}`);
check("换到了别的端口", b.port !== FIXED);
check("标记了 fellBack，调用方才能如实提示", b.fellBack === true);
check("requestedPort 留着，提示里要说清原本想用哪个", b.requestedPort === FIXED);
check(
  "FOREMAN_DASHBOARD_PORT 指向最后起来的真实端口（引导链接靠它）",
  process.env.FOREMAN_DASHBOARD_PORT === String(b.port),
  process.env.FOREMAN_DASHBOARD_PORT,
);

process.stdout.write("\n── 两个实例都真的在服务 ──\n");
for (const [name, bk] of [
  ["首个", a],
  ["回退后", b],
] as const) {
  const res = await fetch(`${bk.url}/health`);
  check(`${name}实例 /health 可达`, res.ok, `${res.status}`);
}

process.stdout.write("\n── 守护进程语义：不开回退必须硬失败 ──\n");
let message = "";
try {
  await startLocalBackend({ port: FIXED, host: "127.0.0.1" });
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
check("抛出可读错误而不是静默换端口", message.includes(String(FIXED)), message || "(没抛)");

await a.close();
await b.close();

// 给悬挂 rejection 一个冒出来的机会（unhandledRejection 在微任务队列清空后才触发）
await new Promise((r) => setTimeout(r, 50));
process.stdout.write("\n── 回退不得留下没人接的 rejection ──\n");
check("无 unhandledRejection", unhandled === "", unhandled || "干净");

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
