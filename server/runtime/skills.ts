import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";

/**
 * Skills 加载器：读取 SKILL.md 文件内容，格式化为 system prompt 高优区。
 *
 * Claude Code 的 skills 以 <system-reminder> 注入且压缩时不丢弃。
 * 在 Vercel AI SDK 路线下，我们把 skills 放进 system prompt（LLM API 的 system 参数
 * 独立于 messages，永远不参与 context compression），天然实现「不可压缩」语义。
 *
 * 格式：SKILL.md 有 YAML frontmatter（name / description）+ markdown body。
 * 加载后 body 内容整段注入，frontmatter 的 description 用于动态 skill 发现。
 */

export interface SkillContent {
  name: string;
  description: string;
  body: string;
  source: string;
}

/** 解析 SKILL.md：提取 frontmatter + body */
function parseSkillMd(raw: string): { name?: string; description?: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { body: raw };
  const frontmatter = match[1];
  const body = match[2].trim();
  let name: string | undefined;
  let description: string | undefined;
  for (const line of frontmatter.split("\n")) {
    const [key, ...rest] = line.split(":");
    const val = rest.join(":").trim().replace(/^["']|["']$/g, "");
    if (key.trim() === "name") name = val;
    if (key.trim() === "description") description = val;
  }
  return { name, description, body };
}

/**
 * 扫描 plugin 目录下所有 skills，返回 name → SkillContent 映射。
 * 两个来源合并：builtin plugins/ + user ~/.foreman/plugins/
 */
function discoverAllSkills(): Map<string, SkillContent> {
  const map = new Map<string, SkillContent>();
  const roots = [
    { dir: config.pluginsDir, prefix: "builtin" },
    { dir: config.userPluginsDir, prefix: "user" },
  ];
  for (const { dir, prefix } of roots) {
    const skillsDir = join(dir, "skills");
    if (!existsSync(skillsDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(skillsDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const mdPath = join(skillsDir, name, "SKILL.md");
      if (!existsSync(mdPath)) continue;
      try {
        const raw = readFileSync(mdPath, "utf-8");
        const parsed = parseSkillMd(raw);
        const key = `${prefix}:${parsed.name || name}`;
        map.set(key, {
          name: parsed.name || name,
          description: parsed.description || "",
          body: parsed.body,
          source: key,
        });
      } catch {
        continue;
      }
    }
  }
  return map;
}

let _cache: Map<string, SkillContent> | undefined;

function allSkills(): Map<string, SkillContent> {
  // 每次调用重新扫描（文件不多，微秒级），保证新增 skill 立即可用
  _cache = discoverAllSkills();
  return _cache;
}

/** 按 profile.skills 名单加载 skill 内容 */
export function loadSkills(skillNames: string[]): SkillContent[] {
  if (!skillNames.length) return [];
  const skills = allSkills();
  const result: SkillContent[] = [];
  for (const ref of skillNames) {
    const skill = skills.get(ref);
    if (skill) {
      result.push(skill);
    } else {
      // 尝试短名匹配（如 "hire-employee" → "builtin:hire-employee"）
      for (const [key, val] of skills) {
        if (key.endsWith(`:${ref}`)) {
          result.push(val);
          break;
        }
      }
    }
  }
  return result;
}

/** 列出所有可用 skill（供 Skill 工具的发现功能与后台管理界面） */
export function listAvailableSkills(): Array<{ name: string; source: string; description: string }> {
  return [...allSkills().values()].map((s) => ({
    name: s.name,
    source: s.source,
    description: s.description.slice(0, 200),
  }));
}

/**
 * 按引用名取单个 skill。引用名形如 `user:web-search`；
 * 也接受短名（`web-search`）——与 loadSkills 的回退规则保持一致，
 * 免得模型漏写前缀就取不到。
 */
export function getSkill(ref: string): SkillContent | undefined {
  const skills = allSkills();
  const direct = skills.get(ref);
  if (direct) return direct;
  for (const [key, val] of skills) {
    if (key.endsWith(`:${ref}`)) return val;
  }
  return undefined;
}

/**
 * 格式化 skills 为 system prompt 高优区块。
 * 注入在 system prompt 最前面，确保优先级最高、永不被压缩。
 */
export function formatSkillsForSystemPrompt(skills: SkillContent[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map(
    (s) => `<skill name="${s.name}" source="${s.source}">\n${s.body}\n</skill>`,
  );
  return [
    "## 已激活技能（Skills）",
    "以下技能内容具有最高优先级，请严格遵循其中的指令。",
    "",
    ...blocks,
    "",
  ].join("\n");
}

/**
 * L1 发现层：只列 skill 的引用名与一句话说明，**不含正文**。
 *
 * 对齐 Claude Code 的三级渐进披露：清单约 80 token/skill，而正文中位数约 2000 token。
 * 全部塞进 system 会让「一次都用不到的技能」也一直占着上下文（本仓库最大的
 * yoho-yuque 有 14k 字符 ≈ 8k token），所以正文交给 Skill 工具按需取。
 *
 * @param exclude 已在 L0 预载正文的引用名——同一个 skill 不必在清单里再出现一次
 */
export function formatSkillCatalog(exclude: string[] = []): string {
  const skipped = new Set(exclude);
  const rows = [...allSkills().values()]
    .filter((s) => !skipped.has(s.source))
    .map((s) => `- \`${s.source}\`：${s.description || s.name}`);
  if (rows.length === 0) return "";
  return [
    "## 可按需加载的技能（Skills）",
    "下面是当前可用的技能清单（只有名称与说明）。判断某个技能与当前任务相关时，",
    "**调用 `Skill` 工具并传入反引号里的引用名**取回完整操作手册，再照着做。",
    "不相关就不要加载——加载会占用上下文。",
    "",
    ...rows,
    "",
  ].join("\n");
}
