import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { JudgeInput, RunPaths } from "./types.js";
import { copyReadOnly, ensureDir, writeJson } from "./files.js";

/**
 * 证据只读物化。
 *
 * Provenance：逐字照搬 agent-bench 的 `src/judge/materializer.ts`（仅改 import 路径）。
 * 这里的每处细节都由实测事故驱动，刻意不重写：
 *   - sourceToTarget 独立去重表：pathMap 是 target→source，拿它查 source 永远不命中，
 *     同一路径在 evidence 里出现两次就会往 0444 的目标重复拷贝并抛 EACCES
 *   - removeMaterialized 先 chmod 再 rm：0555 目录的子项无法 unlink，
 *     直接 rmSync 抛 ENOTEMPTY，judge 重试时整个维度被判 invalid
 */

export interface MaterializedJudgeInput {
  workspace: string;
  evidenceFile: string;
  rubricFile: string;
  schemaFile: string;
  pathMap: Map<string, string>;
}

function safeName(source: string): string {
  return `${crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)}-${path.basename(source)}`;
}

function replacePaths(value: unknown, copy: (source: string) => string): unknown {
  if (typeof value === 'string' && path.isAbsolute(value) && fs.existsSync(value)) return copy(value);
  if (Array.isArray(value)) return value.map((item) => replacePaths(item, copy));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replacePaths(item, copy)]));
  return value;
}

/**
 * 删除上一次物化的残留。
 * 必须先恢复写权限：materials 里可能有 copyReadOnly 留下的 0o555 目录
 * （evidence 里出现目录类绝对路径时会被整棵复制），其子项无法 unlink，
 * 直接 rmSync 会抛 ENOTEMPTY——judge 重试时整个维度就被判 invalid 了。
 */
function removeMaterialized(root: string): void {
  if (!fs.existsSync(root)) return;
  const unlock = (entry: string): void => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entry);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      try {
        fs.chmodSync(entry, 0o755);
      } catch {
        /* 尽力而为 */
      }
      for (const child of fs.readdirSync(entry)) unlock(path.join(entry, child));
    } else {
      try {
        fs.chmodSync(entry, 0o644);
      } catch {
        /* 尽力而为 */
      }
    }
  };
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
}

export function materializeJudgeInput(paths: RunPaths, input: JudgeInput): MaterializedJudgeInput {
  const root = path.join(paths.judge, input.metric);
  removeMaterialized(root);
  ensureDir(path.join(root, 'input'));
  const materialsRoot = path.join(root, 'materials');
  ensureDir(materialsRoot);
  const pathMap = new Map<string, string>();
  // 去重必须用独立的 source→target 映射：pathMap 是 target→source（供 restore 反查），
  // 拿它查 source 永远命中不了，同一路径在 evidence 里出现多次就会重复拷贝到
  // 已经 chmod 0444 的目标上抛 EACCES。
  const sourceToTarget = new Map<string, string>();
  const copy = (source: string): string => {
    const existing = sourceToTarget.get(source);
    if (existing) return existing;
    const target = path.join(materialsRoot, safeName(source));
    if (fs.statSync(source).isDirectory()) copyReadOnly(source, target);
    else {
      ensureDir(path.dirname(target));
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o444);
    }
    sourceToTarget.set(source, target);
    pathMap.set(target, source);
    return target;
  };
  for (const material of input.materials) copy(material.source);
  const evidence = replacePaths(input.evidence, copy);
  const evidenceFile = path.join(root, 'input', 'evidence.json');
  const rubricFile = path.join(root, 'input', 'rubric.md');
  const schemaFile = path.join(root, 'input', 'output-schema.json');
  writeJson(evidenceFile, evidence);
  fs.writeFileSync(rubricFile, input.rubric, 'utf8');
  writeJson(schemaFile, input.outputSchema);
  fs.chmodSync(path.join(root, 'input'), 0o555);
  // SDK 的运行 HOME 位于 workspace 外；Judge cwd 自身也不保留可写入口。
  fs.chmodSync(root, 0o555);
  return { workspace: root, evidenceFile, rubricFile, schemaFile, pathMap };
}

export function restoreMaterializedPaths(value: unknown, pathMap: Map<string, string>): unknown {
  if (typeof value === 'string') return pathMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => restoreMaterializedPaths(item, pathMap));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, restoreMaterializedPaths(item, pathMap)]));
  return value;
}
