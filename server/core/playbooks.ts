import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";

export interface CommandMeta {
  /** 短调用名（不含斜杠），即 md 文件名 */
  name: string;
  /** SDK 实际注册名：<plugin>:<name> */
  fullName: string;
  description?: string;
  argumentHint?: string;
  /** 所属 plugin 目录名 */
  plugin: string;
}

function isPluginRoot(root: string): boolean {
  return (
    existsSync(join(root, ".claude-plugin")) &&
    (existsSync(join(root, "commands")) || existsSync(join(root, "skills")))
  );
}

/**
 * 固定两个 plugin：
 * - builtin：仓库 plugins/（进 git），内置岗位配套 skill，引用写 "builtin:<skill>"
 * - user：<用户目录>/plugins/（出厂预置播种 + 自装），引用写 "user:<skill>"
 * skill/command 直接平铺（skills/<name>/SKILL.md、commands/<name>.md），无需再分组。
 */
export function listPluginDirs(): string[] {
  return [config.pluginsDir, config.userPluginsDir].filter(isPluginRoot);
}

/** 简易 frontmatter 解析：--- 包围的 key: value 行 */
function parseFrontmatter(raw: string): Record<string, string> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** plugin 名以 manifest（.claude-plugin/plugin.json）为准，目录名不可靠 */
function pluginNameOf(root: string): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf-8"),
    ) as { name?: string };
    if (manifest.name) return manifest.name;
  } catch {
    /* 回落目录名 */
  }
  return root.split("/").pop()!;
}

/** 全部 plugin 的 command 元数据（CLI 补全 / 菜单数据源） */
export function listCommands(): CommandMeta[] {
  const commands: CommandMeta[] = [];
  for (const pluginDir of listPluginDirs()) {
    const commandsDir = join(pluginDir, "commands");
    if (!existsSync(commandsDir)) continue;
    const plugin = pluginNameOf(pluginDir);
    for (const file of readdirSync(commandsDir)) {
      if (!file.endsWith(".md")) continue;
      const fm = parseFrontmatter(
        readFileSync(join(commandsDir, file), "utf-8"),
      );
      const name = file.replace(/\.md$/, "");
      commands.push({
        name,
        fullName: `${plugin}:${name}`,
        description: fm.description,
        argumentHint: fm["argument-hint"],
        plugin,
      });
    }
  }
  return commands;
}

/**
 * 短名重写：SDK 里 plugin command 注册为 <plugin>:<name>，
 * 用户输入 /repo-brief 时改写为 /user:repo-brief（短名唯一才改写）。
 */
export function resolveCommandPrompt(prompt: string): string {
  const m = prompt.match(/^\/([\w-]+)(\s|$)/);
  if (!m) return prompt;
  const matches = listCommands().filter((c) => c.name === m[1]);
  if (matches.length !== 1) return prompt;
  return prompt.replace(/^\/[\w-]+/, `/${matches[0].fullName}`);
}
