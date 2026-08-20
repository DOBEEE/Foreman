import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { config } from "../config/index.js";
import { listAvailableSkills } from "../runtime/skills.js";

/**
 * Skill 的后台增删改（只写用户侧 <runtimeDir>/plugins/skills/<name>/SKILL.md）。
 *
 * 内置侧仓库 plugins/skills/ 进 git、由代码管理，不从后台改——
 * 与 agent 的「内置改文件、招聘走 dashboard」是同一套规矩。
 *
 * skill 的运行时消费见 runtime/skills.ts：
 * L0 profile.skills 声明的预载进 system；L1 其余只给 name+description 清单；
 * L2 模型用 Skill 工具按需取正文。
 */

export interface SkillSummary {
  /** frontmatter 的 name，也是目录名 */
  name: string;
  description: string;
  /** 引用名 builtin:<name> / user:<name>，profile.skills 与 Skill 工具用它 */
  ref: string;
  /** builtin 的只读 */
  source: "builtin" | "user";
  /** SKILL.md 正文字符数（界面上给个 token 量级的直觉） */
  chars: number;
}

/**
 * skill 名会被拼进文件路径，是本模块唯一的攻击面。
 * 除了正则，saveSkill/deleteSkill 里还要再做一次「解析后必须仍在根目录下」的校验——
 * 正则挡不住的边角（大小写不敏感文件系统、Unicode 归一化）由那道兜底拦。
 */
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function userSkillsRoot(): string {
  return join(config.userPluginsDir, "skills");
}

/** 校验并解析出 skill 目录的绝对路径；越界直接抛 */
function safeUserSkillDir(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new Error("skill 名非法：需 1-64 位小写字母开头的 slug（字母/数字/-/_）");
  }
  const root = resolve(userSkillsRoot());
  const dir = resolve(root, name);
  // 兜底：解析后必须严格位于根目录之内（防 ../ 与各种路径归一化绕过）
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`skill 名越界，拒绝写入：${name}`);
  }
  return dir;
}

export function listSkills(): SkillSummary[] {
  return listAvailableSkills()
    .map((s) => ({
      name: s.name,
      description: s.description,
      ref: s.source,
      source: (s.source.startsWith("builtin:") ? "builtin" : "user") as "builtin" | "user",
      chars: (readSkillBody(s.source) ?? "").length,
    }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/** 按引用名读 SKILL.md 原文（含 frontmatter）。找不到返回 undefined */
export function readSkillBody(ref: string): string | undefined {
  const [prefix, ...rest] = ref.split(":");
  const name = rest.join(":") || prefix;
  const root = prefix === "builtin" ? join(config.pluginsDir, "skills") : userSkillsRoot();
  // 目录名与 frontmatter 的 name 可能不一致，逐个目录读出来比对
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, "SKILL.md");
    if (!existsSync(file)) continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const fmName = raw.match(/^---\n[\s\S]*?\bname:\s*["']?([^"'\n]+)["']?[\s\S]*?\n---/)?.[1]?.trim();
    if (dir === name || fmName === name) return raw;
  }
  return undefined;
}

/**
 * 写用户侧 skill。frontmatter 由这里生成，必须能被 runtime/skills.ts 的
 * parseSkillMd 解析回来（它只认 `^---\n...\n---\n` 且逐行 `key: value`）。
 */
export function saveSkill(input: { name: string; description: string; body: string }): void {
  const dir = safeUserSkillDir(input.name);
  const description = input.description.replace(/\r?\n/g, " ").trim();
  if (!description) throw new Error("description 不能为空——L1 清单靠它让模型判断是否相关");
  const body = input.body.trim();
  if (!body) throw new Error("正文不能为空");
  mkdirSync(dir, { recursive: true });
  const md = `---\nname: ${input.name}\ndescription: ${description}\n---\n\n${body}\n`;
  writeFileSync(join(dir, "SKILL.md"), md, "utf-8");
}

/** 删除用户侧 skill 目录。返回是否真的删掉了东西 */
export function deleteSkill(name: string): boolean {
  const dir = safeUserSkillDir(name);
  if (!existsSync(join(dir, "SKILL.md"))) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 用户侧是否已有同名 skill */
export function userSkillExists(name: string): boolean {
  try {
    return existsSync(join(safeUserSkillDir(name), "SKILL.md"));
  } catch {
    return false;
  }
}

// ─── 外部目录（其他 coding agent 装的 skill）───────────────

export interface ExternalSkill {
  name: string;
  description: string;
  /** 源目录绝对路径 */
  dir: string;
  /** 来源根目录（展示用，让用户知道是 .claude 还是 .qoder 的） */
  root: string;
  /** 用户侧已有同名 → 已导入过 */
  imported: boolean;
  /** 除 SKILL.md 之外还带了哪些附带文件/目录（我们不自动注入，只是提醒） */
  extras: string[];
}

/** 读一个 skill 目录的 frontmatter（只取 name / description） */
function readSkillMeta(dir: string): { name?: string; description?: string } | undefined {
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!fm) return {};
  const pick = (key: string): string | undefined =>
    fm
      .match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
  return { name: pick("name"), description: pick("description") };
}

/**
 * 列出外部目录里可导入的 skill。
 * 这些目录**不参与运行时扫描**（见 config.externalSkillDirs 的说明），
 * 只在这里作为导入候选列出来。
 */
export function listExternalSkills(): ExternalSkill[] {
  const out: ExternalSkill[] = [];
  for (const root of config.externalSkillDirs) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(root, entry);
      const meta = readSkillMeta(dir);
      if (!meta) continue; // 没有 SKILL.md 的目录不是 skill
      const name = meta.name || entry;
      let extras: string[] = [];
      try {
        extras = readdirSync(dir).filter((f) => f !== "SKILL.md");
      } catch {
        /* 列不出附件不影响导入 */
      }
      out.push({
        name,
        description: meta.description ?? "",
        dir,
        root,
        imported: userSkillExists(name),
        extras,
      });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 把外部 skill 复制进用户目录。
 *
 * **按名字从候选里取源路径，不接受调用方传任意路径**——否则这就成了任意目录读取 + 任意
 * 位置写入的组合。落点仍过 safeUserSkillDir。
 * 整目录递归复制（连 scripts/ templates/ 等附带文件），因为 skill 正文常引用它们。
 */
export function importExternalSkill(name: string): { name: string; ref: string; extras: string[] } {
  const candidate = listExternalSkills().find((s) => s.name === name);
  if (!candidate) throw new Error(`外部目录里没有名为 "${name}" 的 skill`);
  const target = safeUserSkillDir(candidate.name);
  mkdirSync(target, { recursive: true });
  cpSync(candidate.dir, target, { recursive: true });
  return { name: candidate.name, ref: `user:${candidate.name}`, extras: candidate.extras };
}
