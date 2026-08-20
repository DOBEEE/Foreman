import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";

/** 首个一级标题，作为索引里的文档摘要 */
function firstHeading(file: string): string {
  try {
    const line = readFileSync(file, "utf-8")
      .split("\n")
      .find((l) => l.startsWith("# "));
    return line ? line.slice(2).trim() : "";
  } catch {
    return "";
  }
}

/**
 * 扫描知识库生成「绝对路径 — 标题」清单，内联进提示词让模型一眼知道有哪些语料，
 * 而不是靠盲猜关键词 Grep。每次运行重扫，文档更新即生效（目录小，成本可忽略）。
 * 通过 {{knowledgeIndex}} 模板占位使用（按需计算，见 BaseAgent.buildSystemPrompt）。
 */
export function buildKnowledgeIndex(root = config.knowledgeDir): string {
  if (!existsSync(root)) {
    return `（知识库目录 ${root} 不存在，本次仅依据联网与自身知识作答）`;
  }
  const lines: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.(md|txt)$/i.test(entry.name)) {
        const title = firstHeading(full);
        lines.push(title ? `- \`${full}\` — ${title}` : `- \`${full}\``);
      }
    }
  };
  walk(root, 0);
  return lines.length ? lines.join("\n") : "（知识库暂无文档）";
}

/** codeRoots 的提示词展示形态（{{codeRoots}} 占位） */
export function formatCodeRoots(): string {
  return config.codeRoots.length
    ? config.codeRoots.map((p) => `\`${p}\``).join("、")
    : "（未配置，本次无法查看源码）";
}
