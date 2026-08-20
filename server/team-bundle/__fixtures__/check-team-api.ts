/**
 * 团队配置管理 API 端到端回归。
 *
 * **必须在独立 RUNTIME_DIR 下运行**，由 requireIsolatedRuntimeDir 真的执行 ——
 * 它会走完整的导入事务，跑在默认目录上会覆写用户真实的 boss 人格与员工配置且不报错。
 */
import express from "express";
import { saveHiredProfile } from "../../config/agent-profile.js";
import { createConsoleRouter } from "../../api/dashboard.js";
import { requireIsolatedRuntimeDir } from "./isolation-guard.js";

// 第一个写操作之前就拦住
requireIsolatedRuntimeDir("server/team-bundle/__fixtures__/check-team-api.ts");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

saveHiredProfile({
  id: "api-fixture",
  displayName: "接口测试员",
  description: "验证团队包 API",
  routeHint: "【选我当】测试接口时\n【别选我当】生产任务",
  type: "simple",
  systemPrompt: "只做接口测试",
  model: "must-stay-local",
});

const app = express();
app.use("/api/console", createConsoleRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const address = server.address();
if (!address || typeof address === "string") throw new Error("测试服务器没有端口");
const base = `http://127.0.0.1:${address.port}/api/console`;

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

try {
  process.stdout.write("\n── 导出预览与下载 ──\n");
  const preview = await json("/team-bundles/export/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "full", name: "API fixture" }),
  });
  check("预览成功", preview.status === 200 && preview.body.agents.some((a: any) => a.id === "api-fixture"));
  const created = await json("/team-bundles/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "full", name: "API fixture" }),
  });
  check("导出记录带下载地址", created.status === 200 && created.body.downloadUrl);
  const downloaded = await fetch(`${base}${created.body.downloadUrl.replace("/api/console", "")}`);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  check("下载得到 gzip 团队包", downloaded.status === 200 && bytes[0] === 0x1f && bytes[1] === 0x8b);

  process.stdout.write("\n── 上传、确认令牌与应用 ──\n");
  const uploadRes = await fetch(`${base}/team-bundles/imports?filename=fixture.ait-team`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  const uploaded = await uploadRes.json() as any;
  check("上传只检查不应用", uploadRes.status === 200 && uploaded.record.status === "inspected");
  const id = uploaded.record.id as string;
  const plan = uploaded.inspection.defaultPlans.merge;
  const savedPlan = await json(`/team-bundles/imports/${id}/plan`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  });
  check("导入方案可保存", savedPlan.status === 200);
  const unconfirmed = await json(`/team-bundles/imports/${id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "wrong" }),
  });
  check("未确认不能应用", unconfirmed.status === 400);
  const confirmation = await json(`/team-bundles/imports/${id}/confirm`, { method: "POST" });
  check("确认产生一次性令牌", confirmation.status === 200 && confirmation.body.token.length > 20);
  const applied = await json(`/team-bundles/imports/${id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: confirmation.body.token }),
  });
  check("确认后事务应用成功", applied.status === 200 && applied.body.snapshotId);
  const reused = await json(`/team-bundles/imports/${id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: confirmation.body.token }),
  });
  check("令牌不能重复使用", reused.status === 400);
  const history = await json("/team-bundles/history");
  check("历史记录和快照可查询", history.status === 200 && history.body.imports.length >= 1 && history.body.snapshots.length >= 1);

  process.stdout.write("\n── 整体覆盖需要更高级别确认 ──\n");
  // 另起一次上传：上面那条已经 applied，状态机不允许再确认
  const upRes2 = await fetch(`${base}/team-bundles/imports?filename=replace.ait-team`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  const up2 = await upRes2.json() as any;
  const id2 = up2.record.id as string;
  await json(`/team-bundles/imports/${id2}/plan`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(up2.inspection.defaultPlans.replace_team),
  });
  const naive = await json(`/team-bundles/imports/${id2}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  check("整体覆盖：不带 acknowledgeReplace 时确认被拒", naive.status === 400, JSON.stringify(naive.body));
  check(
    "拒绝原因说清了会删本地资产",
    typeof naive.body?.error === "string" && naive.body.error.includes("删"),
    String(naive.body?.error),
  );
  const elevated = await json(`/team-bundles/imports/${id2}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ acknowledgeReplace: true }),
  });
  check("带确认后拿到 elevated 令牌", elevated.status === 200 && elevated.body.elevated === true);

  process.stdout.write("\n── 改计划后旧令牌失效 ──\n");
  const upRes3 = await fetch(`${base}/team-bundles/imports?filename=stale.ait-team`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  const up3 = await upRes3.json() as any;
  const id3 = up3.record.id as string;
  await json(`/team-bundles/imports/${id3}/plan`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(up3.inspection.defaultPlans.merge),
  });
  const token3 = await json(`/team-bundles/imports/${id3}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  check("先拿到一个普通令牌", token3.status === 200 && Boolean(token3.body.token));
  // 换计划（这里换成整体覆盖）——旧令牌必须作废，否则等于用低级确认执行了高级操作
  await json(`/team-bundles/imports/${id3}/plan`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(up3.inspection.defaultPlans.replace_team),
  });
  const stale = await json(`/team-bundles/imports/${id3}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: token3.body.token }),
  });
  check("改计划后旧令牌不能再应用", stale.status === 400, JSON.stringify(stale.body));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail) process.exitCode = 1;
