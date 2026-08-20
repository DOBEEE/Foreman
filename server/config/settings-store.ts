import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  config,
  readSettingsOverlay,
  SETTINGS_FILE,
} from "./index.js";

/**
 * 用户设置覆盖层（<runtimeDir>/settings.json）的写入侧。
 * 读取侧在 index.ts（readSettingsOverlay + config Proxy 热更），这里只管落盘：
 * 深合并补丁 → 原子写（tmp+rename）→ 保留最近 5 份 .bak。
 */

const BACKUP_KEEP = 5;

/** 原子写 + 滚动备份：写前把旧文件拷成 <file>.<ts>.bak，只保留最近 N 份 */
export function atomicWriteWithBackup(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      copyFileSync(file, `${file}.${stamp}.bak`);
      pruneBackups(file);
    } catch {
      /* 备份失败不阻断主写入 */
    }
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, file);
}

function pruneBackups(file: string): void {
  const dir = dirname(file);
  const prefix = `${basename(file)}.`;
  const backups = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".bak"))
    .sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
    try {
      rmSync(join(dir, stale));
    } catch {
      /* ignore */
    }
  }
}

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 深合并：对象递归合并，其余（含数组）整体替换；补丁里显式设为 null 的键 → 删除 */
function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k] as Json, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 读取当前覆盖层原文（给 dashboard 展示「哪些字段被覆盖了」） */
export function getSettingsOverlay(): Json {
  return readSettingsOverlay() as Json;
}

/**
 * 合并写入设置覆盖层：dashboard 只提交它改动的字段，这里深合并进已有覆盖层。
 * 返回合并后的完整覆盖层。config 会在下次读属性时按 mtime 自动热更。
 */
export function patchSettings(patch: Json): Json {
  const merged = deepMerge(getSettingsOverlay(), patch);
  atomicWriteWithBackup(SETTINGS_FILE, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

// ─── 主管人设覆盖层（<runtimeDir>/boss.json） ─────────────────
// 内置 server/config/boss.json 进 git、不宜被 dashboard 直改；用户改动落到运行时覆盖层，
// persona.loadBossPersona 会把两者浅合并（overlay 覆盖内置）。

export function bossOverlayFile(): string {
  return join(config.runtimeDir, "boss.json");
}

export function readBossOverlay(): Json {
  const file = bossOverlayFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Json;
  } catch (error) {
    console.warn(`[settings] 解析 ${file} 失败:`, error);
    return {};
  }
}

export function writeBossOverlay(next: Json): void {
  atomicWriteWithBackup(bossOverlayFile(), `${JSON.stringify(next, null, 2)}\n`);
}
