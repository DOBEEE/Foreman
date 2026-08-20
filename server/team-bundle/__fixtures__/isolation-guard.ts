import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/index.js";

/**
 * 会**覆写用户真实配置**的 fixture 的准入闸。
 *
 * 为什么必须是代码而不是注释：team-bundle 那两个 fixture 顶上原本就写着「必须在独立
 * RUNTIME_DIR 下运行」，但没有任何东西执行这条。真实后果 —— 一次全量回归把用户的 boss
 * 人格（李广进）整个换成了团队包里的测试人格「测试主管」，而且**没有任何报错**：
 * 导入是成功的，只是导错了地方。之后要靠 team-bundles/snapshots 里的旧快照才捞回来。
 *
 * 这类前置条件一律要 fail-closed：宁可 fixture 拒跑（一眼看见），
 * 也不要它默默跑在真实数据上（要等下一次 boss 说话才发现人格不对）。
 */
export function requireIsolatedRuntimeDir(fixtureName: string): void {
  const defaultDir = join(homedir(), ".foreman");
  const isolated = Boolean(process.env.RUNTIME_DIR) && config.runtimeDir !== defaultDir;
  if (isolated) return;
  process.stderr.write(
    [
      `\n❌ ${fixtureName} 拒绝运行：它会覆写真实运行目录里的用户配置（boss 人格 / 员工 / MCP / Skill）。`,
      `   当前 runtimeDir = ${config.runtimeDir}`,
      "",
      "   请给一个独立目录再跑，例如：",
      `     RUNTIME_DIR=$(mktemp -d) npx tsx ${fixtureName}`,
      "",
      "   （不是「建议」而是硬要求：这个 fixture 做的是团队导入，导入本身会成功，",
      "     只是把你的真实配置换成了测试团队的，且不会报任何错。）",
      "",
    ].join("\n"),
  );
  process.exit(2);
}
