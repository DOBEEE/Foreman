import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * 全部 fixture 的统一入口（`npm test`）。
 *
 * 为什么需要它：这个仓库的测试是一批 `check-*.ts` —— 每个自跑、自打分、
 * 失败时 `process.exitCode = 1`。此前只能一个个手动跑，别人改了代码根本不知道
 * 怎么验证。CI 也需要一个确定的退出码。
 *
 * 每个 fixture 用**独立子进程**跑，不 import 进本进程：它们各自 mutate 环境变量、
 * 写临时目录、有的还起 HTTP 服务，同进程串跑会互相污染。子进程隔离最省心。
 *
 * agent-bench 那类需要 sibling checkout 的 fixture 缺依赖时**自己**打印「跳过」并 exit 0，
 * 所以这里不需要知道谁能跑谁不能 —— 退出码就是唯一判据。
 */

// 本文件在 server/cli/，上溯两级才是仓库根
const root = fileURLToPath(new URL("../..", import.meta.url));

function findFixtures(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...findFixtures(full));
    } else if (entry.name.startsWith("check-") && entry.name.endsWith(".ts") && full.includes("__fixtures__")) {
      out.push(full);
    }
  }
  return out;
}

function run(file: string): Promise<{ file: string; code: number; tail: string }> {
  return new Promise((resolve) => {
    // 每个 fixture 一个独立 RUNTIME_DIR：team-bundle 那几个会做真实团队导入、覆写运行目录，
    // 靠 isolation-guard 拒绝在默认目录跑；给临时目录既满足它，也让所有 fixture 互不污染、
    // 不碰开发者本机的 ~/.foreman
    const runtimeDir = mkdtempSync(join(tmpdir(), "foreman-test-"));
    const env = { ...process.env, RUNTIME_DIR: runtimeDir };
    // 先播种预置：部分 fixture 依赖预置岗位（如 coder 的 reviewer 字段），而真实安装
    // 本来就带这些——空目录不代表真实安装。seedUserDir 在 import 期读 RUNTIME_DIR，
    // 所以只能用独立子进程，不能在本进程 import
    const seed = spawn(
      "npx",
      ["tsx", "-e", "import('./server/config/seed.js').then(m => m.seedUserDir())"],
      { cwd: root, env },
    );
    seed.on("close", () => {
      const child = spawn("npx", ["tsx", file], { cwd: root, env });
      let buf = "";
      child.stdout.on("data", (d) => (buf += d));
      child.stderr.on("data", (d) => (buf += d));
      child.on("close", (code) => {
        rmSync(runtimeDir, { recursive: true, force: true });
        // 抽出打分行（「━━━ N/M 通过 ━━━」或「跳过」），没有就取最后一行非空
        const scoreLine =
          buf.split("\n").reverse().find((l) => /━━━|跳过/.test(l))?.trim() ??
          buf.split("\n").filter((l) => l.trim()).slice(-1)[0]?.trim() ??
          "(无输出)";
        resolve({ file, code: code ?? 1, tail: scoreLine });
      });
    });
  });
}

const fixtures = findFixtures(join(root, "server")).sort();
process.stdout.write(`\n运行 ${fixtures.length} 个 fixture…\n\n`);

// 串行：部分 fixture 会起 HTTP 服务抢端口、mutate 全局环境变量，并发会互相干扰
const failed: string[] = [];
for (const file of fixtures) {
  const rel = file.slice(root.length);
  const result = await run(file);
  const mark = result.code === 0 ? "✅" : "❌";
  process.stdout.write(`${mark} ${rel.padEnd(58)} ${result.tail}\n`);
  if (result.code !== 0) failed.push(rel);
}

process.stdout.write(`\n${"─".repeat(72)}\n`);
if (failed.length) {
  process.stdout.write(`❌ ${failed.length}/${fixtures.length} 个 fixture 失败：\n`);
  for (const f of failed) process.stdout.write(`   ${f}\n`);
  process.exit(1);
}
process.stdout.write(`✅ 全部 ${fixtures.length} 个 fixture 通过\n`);
