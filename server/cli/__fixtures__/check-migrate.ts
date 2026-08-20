/**
 * 换设备迁移校验（零 LLM，纯断言）。
 *
 * 守的是三条会导致「搬完发现东西丢了 / 新机行为诡异」的不变式：
 * 1. 排除清单只排可再生或换机必然失效的东西 —— memory / notes / schedules / bench
 *    这些一旦被误排，用户的经验库和定时任务就静默消失了
 * 2. locks 必须被排除并在导入时防御性剥离 —— 里面存的是源机 pid，
 *    带过去会让新机误判「该 token 已被另一进程持有」而跳过钉钉渠道（真事故）
 * 3. settings.json 的本机路径要按 home 前缀重写，改不了的必须显式报出来而不是静默留错
 *
 * 用法：npx tsx server/cli/__fixtures__/check-migrate.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { _internals, MIGRATE_HELP } from "../migrate.js";

let pass = 0;
const fails: string[] = [];

function check(label: string, ok: boolean, extra?: string): void {
  if (ok) {
    pass++;
    process.stdout.write(`  ✅ ${label}\n`);
  } else {
    fails.push(label);
    process.stdout.write(`  ❌ ${label}${extra ? ` — ${extra}` : ""}\n`);
  }
}

const { EXCLUDED, SECRET_FILES, rewriteSettings, runningHolder } = _internals;
const sandbox = mkdtempSync(join(tmpdir(), "foreman-migrate-test-"));
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));

process.stdout.write("\n▶ 排除清单的边界\n");
{
  const excluded = new Set<string>(EXCLUDED);
  // 这些是用户真资产，误排等于静默丢数据
  for (const keep of ["memory", "notes", "schedules.json", "bench", "boss", "agents", "chats", "proposals", "workbench", "archive", "sessions"]) {
    check(`不排除用户资产 ${keep}`, !excluded.has(keep));
  }
  // 这些必须排
  check("排除 workspaces（可再生，占绝大部分体积）", excluded.has("workspaces"));
  check("排除 agent-bench（评测产物可重跑）", excluded.has("agent-bench"));
  check("排除 locks（存源机 pid，会让新机误判被占用）", excluded.has("locks"));
  check("排除 inbound（附件缓存，换机后路径失效）", excluded.has("inbound"));
}

process.stdout.write("\n▶ 密钥文件清单\n");
{
  const secrets = new Set<string>(SECRET_FILES);
  check("credentials.json 计入密钥", secrets.has("credentials.json"));
  check("secrets.json 计入密钥", secrets.has("secrets.json"));
  check("providers.json 计入密钥", secrets.has("providers.json"));
  check("--no-secrets 在帮助里有说明", MIGRATE_HELP.includes("--no-secrets"));
  check("帮助里说明 .env 需单独拷", MIGRATE_HELP.includes(".env"));
}

process.stdout.write("\n▶ settings.json 路径重写\n");
{
  const dir = join(sandbox, "rewrite");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  const oldHome = "/Users/olduser";
  const newHome = homedir();
  // 造一个本机真实存在的子路径，验证「已存在的路径不会被误报为 unresolved」
  const realSub = join(newHome, ".foreman");
  writeFileSync(
    file,
    JSON.stringify({
      model: "keep-me",
      paths: {
        workingDir: `${oldHome}/code/proj`,
        knowledgeDir: `${oldHome}/.foreman/knowledge`,
        codeRoots: [`${oldHome}/code/a`, "/Volumes/ExternalDisk/code/b"],
      },
    }),
  );

  const manifest = {
    format: "foreman-migrate" as const,
    version: 1 as const,
    createdAt: new Date().toISOString(),
    sourceRuntimeDir: `${oldHome}/.foreman`,
    sourceHome: oldHome,
    sourcePlatform: "darwin",
    excluded: [...EXCLUDED],
    includesSecrets: true,
  };

  const result = rewriteSettings(file, manifest, true);
  const after = JSON.parse(readFileSync(file, "utf-8")) as {
    model: string;
    paths: { workingDir: string; knowledgeDir: string; codeRoots: string[] };
  };

  check(
    "workingDir 的 home 前缀被换成本机 home",
    after.paths.workingDir === join(newHome, "code/proj"),
    after.paths.workingDir,
  );
  check(
    "knowledgeDir 同样被重写",
    after.paths.knowledgeDir === join(newHome, ".foreman/knowledge"),
    after.paths.knowledgeDir,
  );
  check(
    "codeRoots 数组内逐项重写",
    after.paths.codeRoots[0] === join(newHome, "code/a"),
    after.paths.codeRoots[0],
  );
  // 猜不出的路径（外置盘）必须原样留下 + 显式报出来，不能静默改错或悄悄丢
  check(
    "外置盘路径原样保留",
    after.paths.codeRoots[1] === "/Volumes/ExternalDisk/code/b",
  );
  check(
    "猜不出的路径被列进 unresolved 让人手工改",
    result.unresolved.some((u) => u.includes("/Volumes/ExternalDisk/code/b")),
    JSON.stringify(result.unresolved),
  );
  check("非路径字段不被动", after.model === "keep-me");
  check("重写项都记进 changed 供报告", result.changed.length === 3, String(result.changed.length));

  // 同 home 迁移（换机但用户名相同）：不该产生任何重写
  const same = join(dir, "same.json");
  writeFileSync(same, JSON.stringify({ paths: { workingDir: realSub } }));
  const r2 = rewriteSettings(same, { ...manifest, sourceHome: newHome }, true);
  check("源与目标 home 相同时不重写", r2.changed.length === 0);
  check("已存在的路径不报 unresolved", r2.unresolved.length === 0, JSON.stringify(r2.unresolved));

  // 缺文件 / 无 paths 段都不该抛
  const missing = rewriteSettings(join(dir, "nope.json"), manifest, true);
  check("settings.json 不存在时安静返回", missing.changed.length === 0 && missing.unresolved.length === 0);
  const noPaths = join(dir, "nopaths.json");
  writeFileSync(noPaths, JSON.stringify({ model: "x" }));
  check("没有 paths 段时安静返回", rewriteSettings(noPaths, manifest, true).changed.length === 0);
  // 坏 JSON 要报出来而不是静默跳过
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json");
  check(
    "settings.json 解析失败时列进 unresolved",
    rewriteSettings(broken, manifest, true).unresolved.length === 1,
  );
}

process.stdout.write("\n▶ apply=false 只报告不落盘\n");
{
  const dir = join(sandbox, "dryrun");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  const original = JSON.stringify({ paths: { workingDir: "/Users/olduser/x" } });
  writeFileSync(file, original);
  const manifest = {
    format: "foreman-migrate" as const,
    version: 1 as const,
    createdAt: "",
    sourceRuntimeDir: "/Users/olduser/.foreman",
    sourceHome: "/Users/olduser",
    sourcePlatform: "darwin",
    excluded: [],
    includesSecrets: false,
  };
  const r = rewriteSettings(file, manifest, false);
  check("apply=false 仍算出 changed", r.changed.length === 1);
  check("apply=false 不写盘", readFileSync(file, "utf-8") === original);
}

process.stdout.write("\n▶ 运行中检测（拒绝导入的闸门）\n");
{
  // runningHolder 读的是 config.runtimeDir/locks。夹具跑在独立 RUNTIME_DIR 下，
  // 该目录没有 locks/，所以应判为「没有活进程」
  check("无 locks 目录时判为未运行", runningHolder() === undefined);

  // 陈旧锁（pid 已死）不该阻塞导入：否则崩溃过一次就再也导不进来
  const lockDir = join(process.env.RUNTIME_DIR ?? sandbox, "locks");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "stale.lock"), "999999");
  check("陈旧锁（pid 已死）不算运行中", runningHolder() === undefined);

  // 活锁必须拦住
  writeFileSync(join(lockDir, "live.lock"), String(process.pid));
  check("活锁被识别为运行中", runningHolder() === process.pid);
  rmSync(lockDir, { recursive: true, force: true });

  // 空 / 损坏锁文件：Number("") === 0，kill(0,0) 探的是当前进程组恒为真，
  // 这里必须靠 pid > 0 的校验挡住，否则一个空锁文件就永久堵死导入
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "empty.lock"), "");
  check("空锁文件不被误判成运行中", runningHolder() === undefined);
  writeFileSync(join(lockDir, "junk.lock"), "not-a-pid");
  check("损坏锁文件不被误判成运行中", runningHolder() === undefined);
  rmSync(lockDir, { recursive: true, force: true });
}

process.stdout.write("\n▶ tar 排除参数真的生效（端到端）\n");
{
  // 直接验 tar 行为：--exclude=<base>/<dir> 的写法在 bsdtar/gnutar 上都要成立，
  // 写错了不会报错，只会静默把 228M workspaces 打进包
  const root = join(sandbox, "rt");
  mkdirSync(join(root, "workspaces", "deep"), { recursive: true });
  mkdirSync(join(root, "locks"), { recursive: true });
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "workspaces", "deep", "big.bin"), "x");
  writeFileSync(join(root, "locks", "a.lock"), "123");
  writeFileSync(join(root, "memory", "keep.md"), "经验");
  writeFileSync(join(root, "schedules.json"), "[]");
  writeFileSync(join(root, "credentials.json"), "{}");

  const out = join(sandbox, "t.tgz");
  const args = ["-czf", out, "-C", sandbox];
  for (const dir of EXCLUDED) args.push(`--exclude=rt/${dir}`);
  args.push("rt");
  execFileSync("tar", args);
  const listing = execFileSync("tar", ["-tzf", out], { encoding: "utf-8" });

  check("workspaces 未进包", !listing.includes("rt/workspaces"), listing);
  check("locks 未进包", !listing.includes("rt/locks"));
  check("memory 进包了", listing.includes("rt/memory/keep.md"));
  check("schedules.json 进包了", listing.includes("rt/schedules.json"));
  check("默认带上密钥文件", listing.includes("rt/credentials.json"));

  // --no-secrets 变体
  const out2 = join(sandbox, "t2.tgz");
  const args2 = ["-czf", out2, "-C", sandbox];
  for (const dir of EXCLUDED) args2.push(`--exclude=rt/${dir}`);
  for (const f of SECRET_FILES) args2.push(`--exclude=rt/${f}`);
  args2.push("rt");
  execFileSync("tar", args2);
  const listing2 = execFileSync("tar", ["-tzf", out2], { encoding: "utf-8" });
  check("--no-secrets 时 credentials.json 不进包", !listing2.includes("rt/credentials.json"));
  check("--no-secrets 时 memory 仍进包", listing2.includes("rt/memory/keep.md"));
}

const total = pass + fails.length;
process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
process.exit(fails.length ? 1 : 0);
