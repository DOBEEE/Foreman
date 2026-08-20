import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { config } from "../config/index.js";

/**
 * 换设备迁移（零 LLM）。
 *
 * 为什么不能用团队导出（`.ait-team`）代替：那个包是「把团队分享给同事」，
 * `team-bundle/bundle.ts` 的 security.excluded 明确排除
 * `sessions/tasks/logs/memory/notes/schedules` 与一切密钥——分享场景下带上它们就是泄漏。
 * 而换设备是**同一个人**搬家，经验库、笔记、定时任务、回归基线、任务历史一个都不能丢。
 * 两者语义相反，所以各走各的命令。
 *
 * 迁移的是 `<runtimeDir>`（默认 `~/.foreman`）。不含代码仓库与 `.env`——
 * 代码用 git/npm 装，`.env` 在仓库根、由用户自己拷（里面是机器相关凭据）。
 */

/**
 * 不进迁移包的目录。判据统一是「可再生 或 换机后必然失效」，不是「大」：
 * - `workspaces`：任务工作区，占了绝大部分体积（实测 228M / 244M），产物已归档进 archive
 * - `agent-bench`：评测跑批产物，随时可重跑
 * - `locks`：存的是**旧机 pid**。带过去会让新机误判「该 token 已被另一进程持有」而跳过钉钉渠道
 * - `inbound`：用户发来的图片/附件缓存，正文里的路径换机后本就失效
 * - `coder-workspace`：历史遗留的工作目录
 */
const EXCLUDED = [
  "workspaces",
  "agent-bench",
  "locks",
  "inbound",
  "coder-workspace",
] as const;

/** 迁移包内的清单文件名。import 靠它判断「这是不是一个迁移包」以及要重写哪些路径 */
const MANIFEST = "migrate-manifest.json";

interface MigrateManifest {
  format: "foreman-migrate";
  version: 1;
  createdAt: string;
  /** 源机的 runtimeDir 绝对路径。import 时与目标对比，决定要不要重写路径 */
  sourceRuntimeDir: string;
  /** 源机 home。settings.json 里指向 home 下的路径靠它做前缀替换 */
  sourceHome: string;
  sourcePlatform: string;
  /** 源机上排除掉的目录，供 import 时告知用户「这些没搬」 */
  excluded: string[];
  /** 包内是否含明文密钥，import 时据此提醒 */
  includesSecrets: boolean;
}

/** settings.json 里会引用本机绝对路径的字段（都在 paths 下） */
const PATH_FIELDS = ["workingDir", "runtimeDir", "knowledgeDir", "pluginsDir"] as const;
/** settings.json 里的路径数组字段 */
const PATH_LIST_FIELDS = ["codeRoots", "externalSkillDirs"] as const;

/** 含明文密钥的文件，export 时据此决定 manifest.includesSecrets 与告警 */
const SECRET_FILES = ["credentials.json", "secrets.json", "providers.json"] as const;

export const MIGRATE_HELP = `foreman migrate — 换设备迁移（搬 ${config.runtimeDir}）

用法:
  foreman migrate export [输出文件]     打包本机运行目录（默认 ./foreman-migrate-<日期>.tgz）
  foreman migrate inspect <包文件>      只读查看包里有什么、源机路径是什么
  foreman migrate import <包文件>       导入到本机（会先把现有目录备份成 .bak-<时间戳>）
  foreman migrate import <包文件> --dry-run   只报告将要发生什么，不落盘

选项:
  --no-secrets    export 时排除 credentials.json / secrets.json / providers.json
                  （新机需重新配模型密钥与渠道凭据）
  --yes           import 时跳过「现有目录将被备份」的确认

不含: 代码仓库（用 git/npm 装）、仓库根的 .env（自己拷，里面是机器相关凭据）
排除: ${EXCLUDED.join(" / ")}（可再生，或换机后必然失效）
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 目标目录里是否有活着的锁（= 本机 foreman 正在跑）。导入时必须拒绝，否则写到一半被覆盖 */
function runningHolder(): number | undefined {
  const lockDir = join(config.runtimeDir, "locks");
  if (!existsSync(lockDir)) return undefined;
  for (const name of readdirSync(lockDir)) {
    if (!name.endsWith(".lock")) continue;
    const pid = Number(readFileSync(join(lockDir, name), "utf-8").trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (e) {
      // ESRCH=进程不存在（陈旧锁，忽略）；EPERM=存在但无权限，当作活着
      if ((e as NodeJS.ErrnoException).code === "EPERM") return pid;
    }
  }
  return undefined;
}

// ─── export ──────────────────────────────────────────────────

function doExport(argv: string[]): void {
  const noSecrets = argv.includes("--no-secrets");
  const outArg = argv.find((a) => !a.startsWith("--"));
  const out = resolve(outArg ?? `foreman-migrate-${new Date().toISOString().slice(0, 10)}.tgz`);

  const root = config.runtimeDir;
  if (!existsSync(root)) fail(`运行目录不存在：${root}`);

  const secretsPresent = SECRET_FILES.filter((f) => existsSync(join(root, f)));
  const manifest: MigrateManifest = {
    format: "foreman-migrate",
    version: 1,
    createdAt: new Date().toISOString(),
    sourceRuntimeDir: root,
    sourceHome: homedir(),
    sourcePlatform: process.platform,
    excluded: [...EXCLUDED, ...(noSecrets ? SECRET_FILES : [])],
    includesSecrets: !noSecrets && secretsPresent.length > 0,
  };
  // 清单写进运行目录，随包一起打进去；打完即删，不留痕
  const manifestPath = join(root, MANIFEST);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  const base = basename(root);
  const args = ["-czf", out, "-C", dirname(root)];
  for (const dir of EXCLUDED) args.push(`--exclude=${base}/${dir}`);
  if (noSecrets) for (const f of SECRET_FILES) args.push(`--exclude=${base}/${f}`);
  args.push(base);

  try {
    execFileSync("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    rmSync(manifestPath, { force: true });
    fail(`打包失败：${error instanceof Error ? error.message : String(error)}`);
  }
  rmSync(manifestPath, { force: true });

  // 包里可能有明文密钥，别让它以 644 躺在磁盘上
  try {
    execFileSync("chmod", ["600", out]);
  } catch {
    /* 设权限失败不阻断，下面的告警会提醒 */
  }

  const size = (statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`✅ 已导出 ${out}（${size} MB，权限 0600）`);
  console.log(`   源运行目录：${root}`);
  console.log(`   已排除：${EXCLUDED.join(" / ")}`);
  if (manifest.includesSecrets) {
    console.log(
      `\n⚠️  包内含明文密钥（${secretsPresent.join(" / ")}）。` +
        `\n   走 U 盘 / AirDrop 传输，不要发聊天工具或上传网盘。` +
        `\n   不想带密钥就加 --no-secrets 重新导（新机需重配模型与渠道凭据）。`,
    );
  }
  console.log(`\n新机上执行：foreman migrate import ${basename(out)}`);
}

// ─── inspect / import ────────────────────────────────────────

/** 从包里读清单（不解包到磁盘，tar -O 直接吐到 stdout） */
function readManifest(file: string): { manifest?: MigrateManifest; topDir: string } {
  let listing: string;
  try {
    listing = execFileSync("tar", ["-tzf", file], { encoding: "utf-8" });
  } catch (error) {
    fail(`无法读取包 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = listing.split("\n").filter(Boolean);
  const topDir = entries[0]?.split("/")[0] ?? "";
  if (!topDir) fail(`包 ${file} 是空的`);

  let manifest: MigrateManifest | undefined;
  try {
    const raw = execFileSync("tar", ["-xzOf", file, `${topDir}/${MANIFEST}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(raw) as MigrateManifest;
    if (parsed.format === "foreman-migrate") manifest = parsed;
  } catch {
    /* 没有清单：可能是手工 tar 的目录，下面按降级处理 */
  }
  return { manifest, topDir };
}

function doInspect(argv: string[]): void {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) fail(`inspect 需要包文件路径\n\n${MIGRATE_HELP}`);
  const abs = resolve(file);
  if (!existsSync(abs)) fail(`文件不存在：${abs}`);

  const { manifest, topDir } = readManifest(abs);
  console.log(`包：${abs}`);
  console.log(`顶层目录：${topDir}`);
  if (!manifest) {
    console.log("⚠️  包里没有 migrate 清单——不是 foreman migrate export 产出的包。");
    console.log("   import 仍可继续，但无法自动重写本机路径。");
    return;
  }
  console.log(`导出时间：${manifest.createdAt}`);
  console.log(`源运行目录：${manifest.sourceRuntimeDir}`);
  console.log(`源 home：${manifest.sourceHome}（${manifest.sourcePlatform}）`);
  console.log(`已排除：${manifest.excluded.join(" / ")}`);
  console.log(`含明文密钥：${manifest.includesSecrets ? "是" : "否"}`);
  const target = config.runtimeDir;
  console.log(`\n本机运行目录：${target}`);
  if (manifest.sourceRuntimeDir !== target) {
    console.log(`   ↳ 与源机不同，import 会重写 settings.json 里的本机路径`);
  }
}

/**
 * 重写 settings.json 里的本机绝对路径：把源机 home 前缀换成本机 home。
 * 只动 home 前缀——跨机器共同的部分只有「用户目录之下的相对结构」，
 * 源机上指向 /Volumes/外置盘 之类的路径无法猜，原样留下并在报告里列出让人自己改。
 */
function rewriteSettings(
  settingsFile: string,
  manifest: MigrateManifest,
  apply: boolean,
): { changed: string[]; unresolved: string[] } {
  const changed: string[] = [];
  const unresolved: string[] = [];
  if (!existsSync(settingsFile)) return { changed, unresolved };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;
  } catch {
    unresolved.push(`${settingsFile}（解析失败，需手工检查）`);
    return { changed, unresolved };
  }
  const paths = parsed.paths as Record<string, unknown> | undefined;
  if (!paths) return { changed, unresolved };

  const oldHome = manifest.sourceHome;
  const newHome = homedir();
  const remap = (value: string): string | undefined => {
    if (!isAbsolute(value)) return undefined;
    if (oldHome !== newHome && value.startsWith(`${oldHome}/`)) {
      return join(newHome, value.slice(oldHome.length + 1));
    }
    return undefined;
  };

  for (const field of PATH_FIELDS) {
    const value = paths[field];
    if (typeof value !== "string" || !value) continue;
    const next = remap(value);
    if (next) {
      changed.push(`paths.${field}: ${value} → ${next}`);
      paths[field] = next;
    } else if (isAbsolute(value) && !existsSync(value)) {
      unresolved.push(`paths.${field} = ${value}（本机不存在，需手工改）`);
    }
  }
  for (const field of PATH_LIST_FIELDS) {
    const list = paths[field];
    if (!Array.isArray(list)) continue;
    const next = list.map((value) => {
      if (typeof value !== "string") return value;
      const mapped = remap(value);
      if (mapped) {
        changed.push(`paths.${field}[]: ${value} → ${mapped}`);
        return mapped;
      }
      if (isAbsolute(value) && !existsSync(value)) {
        unresolved.push(`paths.${field}[] = ${value}（本机不存在，需手工改）`);
      }
      return value;
    });
    paths[field] = next;
  }

  if (apply && changed.length) {
    writeFileSync(settingsFile, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  }
  return { changed, unresolved };
}

function doImport(argv: string[]): void {
  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes");
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) fail(`import 需要包文件路径\n\n${MIGRATE_HELP}`);
  const abs = resolve(file);
  if (!existsSync(abs)) fail(`文件不存在：${abs}`);

  // 前置闸门：本机 foreman 在跑时导入 = 一边写文件一边被读，状态必然错乱
  const holder = runningHolder();
  if (holder !== undefined) {
    fail(
      `本机 foreman 正在运行（pid=${holder}），拒绝导入。\n` +
        `先停掉它再来：kill ${holder}\n` +
        `（同时跑两个实例还会互抢钉钉单实例锁，见 channels/lock.ts）`,
    );
  }

  const { manifest, topDir } = readManifest(abs);
  const target = config.runtimeDir;
  const parent = dirname(target);

  console.log(`包：${abs}`);
  console.log(`目标运行目录：${target}`);
  if (manifest) {
    console.log(`源运行目录：${manifest.sourceRuntimeDir}（${manifest.sourcePlatform}）`);
  } else {
    console.log("⚠️  包内无 migrate 清单，跳过自动路径重写");
  }

  const hasExisting = existsSync(target);
  const backup = `${target}.bak-${ts()}`;
  if (hasExisting) {
    console.log(`\n现有目录会先备份成：${backup}`);
    if (!dryRun && !yes) {
      fail("这一步会移动现有运行目录。确认后加 --yes 重跑，或先用 --dry-run 看报告。");
    }
  }

  if (dryRun) {
    console.log("\n[dry-run] 将执行：");
    if (hasExisting) console.log(`  1. mv ${target} ${backup}`);
    console.log(`  ${hasExisting ? 2 : 1}. 解包到 ${parent}`);
    console.log(`  ${hasExisting ? 3 : 2}. 剥掉包内可能残留的 locks/`);
    if (manifest && manifest.sourceRuntimeDir !== target) {
      console.log(`  ${hasExisting ? 4 : 3}. 重写 settings.json 里的本机路径`);
    }
    console.log("\n[dry-run] 未落盘任何改动。");
    return;
  }

  if (hasExisting) renameSync(target, backup);
  mkdirSync(parent, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", abs, "-C", parent], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    // 解包失败要还原，否则用户的现有目录被搬走了又没拿到新的
    if (hasExisting) {
      rmSync(target, { recursive: true, force: true });
      renameSync(backup, target);
      console.error("解包失败，已还原原有目录。");
    }
    fail(`解包失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 包的顶层目录名可能与目标目录名不同（源机 runtimeDir 名字不一样时）
  const extracted = join(parent, topDir);
  if (extracted !== target) {
    rmSync(target, { recursive: true, force: true });
    renameSync(extracted, target);
  }

  // 防御性剥离：手工 tar 的包可能带着源机 locks/，里面的 pid 会让新机误判「已被占用」
  const strayLocks = join(target, "locks");
  if (existsSync(strayLocks)) {
    rmSync(strayLocks, { recursive: true, force: true });
    console.log("已剥掉包内残留的 locks/（存的是源机 pid）");
  }
  rmSync(join(target, MANIFEST), { force: true });

  console.log(`\n✅ 已导入到 ${target}`);
  if (hasExisting) console.log(`   原目录备份在 ${backup}（确认无误后可删）`);

  let unresolved: string[] = [];
  if (manifest) {
    const result = rewriteSettings(join(target, "settings.json"), manifest, true);
    unresolved = result.unresolved;
    if (result.changed.length) {
      console.log(`\n已重写 settings.json 里的本机路径（${result.changed.length} 处）：`);
      for (const line of result.changed) console.log(`  - ${line}`);
    }
  }

  console.log("\n还需你手工确认：");
  const todos: string[] = [];
  if (unresolved.length) {
    todos.push(`settings.json 里这些路径本机不存在，需手工改：\n     ${unresolved.join("\n     ")}`);
  }
  todos.push("仓库根的 .env 单独拷过来（里面是模型/渠道凭据，不在运行目录内）");
  todos.push(
    "旧机确认停掉 foreman —— 同一个 DINGTALK_CLIENT_ID 两台机器同时跑会互抢单实例锁，" +
      "抢不到的那台仍会跑定时任务并主动推送，消息会漂",
  );
  if (manifest?.includesSecrets === false) {
    todos.push("包内不含密钥（导出时用了 --no-secrets），需重新配模型与渠道凭据");
  }
  todos.push(`已排除的目录不会恢复：${(manifest?.excluded ?? [...EXCLUDED]).join(" / ")}`);
  todos.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
}

export async function runMigrateCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  if (!action || action === "--help" || action === "-h") {
    console.log(MIGRATE_HELP);
    return;
  }
  const rest = argv.slice(1);
  if (action === "export") return doExport(rest);
  if (action === "inspect") return doInspect(rest);
  if (action === "import") return doImport(rest);
  fail(`未知的 migrate 子命令：${action}\n\n${MIGRATE_HELP}`);
}

/** 仅供夹具：复用排除清单与路径重写逻辑做断言 */
export const _internals = {
  EXCLUDED,
  MANIFEST,
  SECRET_FILES,
  rewriteSettings,
  runningHolder,
};
