import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * rubric 定位。
 *
 * Provenance：对应 agent-bench 的 `src/evaluation/scripts.ts` 里的 judgesRoot/judgeAsset，
 * 裁掉了 AIT 评测脚本相关部分（foreman 不跑外部 .mjs 评分脚本）。
 *
 * rubric 是评分口径的一部分，随代码走、进 evaluator 指纹。改 rubric 会让基线失效，
 * 这是预期行为——判据变了，历史分数就不该继续拿来比。
 */
export function rubricsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "rubrics");
}

/** rubric 文件名与维度名不是一一对应，映射在 quality.ts 的 rubricAssetName 收口 */
export function judgeAsset(metric: string, root: string = rubricsRoot()): string {
  return join(root, `benchmark-${metric}-judge.md`);
}
