import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 目录常量：与运行时 cwd 无关，全部由服务安装根推导。
 * server/config/paths.ts → 上两级 = 仓库根（编译后 dist/config/paths.js 同理）。
 */
export const serviceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * 内置配置目录（进 git，随代码发布）：server/config/ 下的
 * app.json / boss.json / mcp.servers.json / agents/。
 * 始终指向源码目录（不是 dist），运行期改文件即时生效。
 */
export const configDir = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR)
  : join(serviceRoot, "server", "config");

/** 内置岗位的声明式配置目录：server/config/agents/<id>.json */
export const builtinAgentsDir = join(configDir, "agents");

/**
 * boss 人格预设目录：server/config/boss-personas/<id>.json。
 * 随代码发布（升级能补新预设、能修错字），**不播种**到用户目录——
 * 用户的选择落在 <runtimeDir>/boss.json 覆盖层里，与这份目录解耦。
 */
export const bossPersonasDir = join(configDir, "boss-personas");

/**
 * 出厂预置目录（进 git）：装机自带的用户资产（预置员工/skill/MCP 模板）。
 * 首次启动播种到用户目录后即归用户所有——可改可删，不会被后续启动覆盖或复活。
 */
export const presetsDir = join(serviceRoot, "presets");

/** 日志目录：仓库根 logs/（.gitignore 已忽略） */
export const logDir = join(serviceRoot, "logs");

/** 逗号分隔的路径列表 → 绝对路径数组 */
export function parsePathList(raw?: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
}
