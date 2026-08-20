import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * 文件与哈希工具。
 *
 * Provenance：逐字照搬 agent-bench 的 `src/utils/files.ts`（只裁掉未用到的 isInside）。
 * 这些函数参与指纹计算与只读物化，实现细节一变，基线可比性与防篡改就变——
 * 所以刻意不「顺手优化」。
 */

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashFile(file: string): string {
  return sha256(readFileSync(file));
}

/** 目录内容哈希：按相对路径排序后逐个喂内容，保证跨机器可复现 */
export function hashTree(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    digest.update(relative(root, file));
    digest.update(readFileSync(file));
  }
  return digest.digest("hex");
}

/**
 * 只读复制：目录 0555、文件 0444。
 *
 * 注意这只是第一道防线——同用户进程可以先 chmod 再写，所以判定前后还要 hashTree 比对。
 * 两层都需要（agent-bench 侧有对应单测证明这一点）。
 */
export function copyReadOnly(source: string, target: string): void {
  cpSync(source, target, { recursive: true, force: true });
  const protect = (entry: string): void => {
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      chmodSync(entry, 0o555);
      for (const child of readdirSync(entry)) protect(join(entry, child));
    } else {
      chmodSync(entry, 0o444);
    }
  };
  protect(target);
}

export { resolve as resolvePath };
