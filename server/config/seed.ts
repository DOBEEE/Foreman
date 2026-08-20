import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { config } from "./index.js";
import { presetsDir } from "./paths.js";

/**
 * 出厂预置播种：把 presets/（进 git 的装机自带资产）复制进用户目录（~/.foreman）。
 *
 * 语义要点——预置资产播种后**归用户所有**：
 * - 只播种「从未播种过」的文件（以 manifest 记录，而不是看文件是否存在）
 * - 用户改过 → 不覆盖（manifest 已记录，跳过）
 * - 用户删了 → 不复活（manifest 已记录，跳过）
 * - 代码升级新增了预置文件 → 下次启动增量播种
 */
const MANIFEST = ".seeded.json";

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** 用户 plugin 清单（SDK 要求）：基础设施文件，缺了自动补，不记入播种账本 */
function ensureUserPluginManifest(): void {
  const manifest = join(config.userPluginsDir, ".claude-plugin", "plugin.json");
  if (existsSync(manifest)) return;
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        name: "user",
        description: "用户 skill/command（出厂预置播种 + 自装），skills/<name>/SKILL.md 即生效",
        version: "0.1.0",
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

export function seedUserDir(): void {
  try {
    mkdirSync(config.runtimeDir, { recursive: true });
    ensureUserPluginManifest();
    const manifestPath = join(config.runtimeDir, MANIFEST);
    let seeded: string[] = [];
    try {
      seeded = JSON.parse(readFileSync(manifestPath, "utf-8")) as string[];
    } catch {
      /* 首次播种 */
    }
    const seededSet = new Set(seeded);
    let added = 0;
    for (const file of walkFiles(presetsDir)) {
      const rel = relative(presetsDir, file);
      if (seededSet.has(rel)) continue;
      const target = join(config.runtimeDir, rel);
      // 目标已存在（如用户手工建过同名文件）也不覆盖，只登记
      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        cpSync(file, target);
        added++;
      }
      seededSet.add(rel);
    }
    if (seededSet.size !== seeded.length) {
      writeFileSync(
        manifestPath,
        `${JSON.stringify([...seededSet].sort(), null, 2)}\n`,
        "utf-8",
      );
    }
    if (added > 0) {
      console.log(`[presets] 已播种 ${added} 份出厂预置到 ${config.runtimeDir}`);
    }
  } catch (error) {
    console.warn("[presets] 播种失败（不影响启动）:", error);
  }
}
