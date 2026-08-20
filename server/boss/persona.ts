import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { config } from "../config/index.js";
import { bossPersonasDir } from "../config/paths.js";
import { getAgent, listRoutableAgents } from "../agents/registry.js";

export interface BossPersona {
  name: string;
  role: string;
  personality: string;
  style: string;
  team?: string;
  /** 头像：单个 emoji 或图片 URL（缺省用 dashboard 内置默认头像） */
  avatar?: string;
  /** 员工拟人化名字覆盖：路由名 → 展示名（如 {"coder": "阿码"}），优先于 agent 自带 displayName */
  employees?: Record<string, string>;
}

/** 人格预设：BossPersona + 供选择器展示的元信息 */
export interface BossPersonaPreset extends BossPersona {
  id: string;
  /** 选择器里的名字 */
  label: string;
  /** 一句话说明这个性格适合什么场景 */
  blurb?: string;
}

/** 可选人格清单（随代码发布，见 paths.bossPersonasDir） */
export function listBossPersonas(): BossPersonaPreset[] {
  let files: string[] = [];
  try {
    files = readdirSync(bossPersonasDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: BossPersonaPreset[] = [];
  for (const f of files.sort()) {
    try {
      const p = JSON.parse(readFileSync(join(bossPersonasDir, f), "utf-8")) as BossPersonaPreset;
      if (p?.id && p.label && p.name) out.push(p);
    } catch {
      console.warn(`[persona] 预设 ${f} 解析失败，已跳过`);
    }
  }
  return out;
}

/**
 * 切换人格：把选中的预设**整对象**写进 <runtimeDir>/boss.json。
 *
 * 必须整写不能合并——覆盖层是对 boss.json 的浅合并，只写部分字段会让新人格
 * 继承上一个的残留（比如换了性格但 employees 里还留着旧称呼）。
 * personaKey 变化会自动作废旧会话，所以不必手动清会话。
 */
export function applyBossPersona(id: string): { ok: boolean; message: string } {
  const preset = listBossPersonas().find((p) => p.id === id);
  if (!preset) return { ok: false, message: `没有这个人格预设：${id}` };
  const { id: _id, label: _label, blurb: _blurb, ...persona } = preset;
  // 保留用户自定的员工称呼：那是他的配置，不属于人格本身
  const current = loadBossPersona();
  const next: BossPersona = {
    ...persona,
    ...(current.employees && Object.keys(current.employees).length
      ? { employees: current.employees }
      : {}),
  };
  try {
    writeFileSync(
      join(config.runtimeDir, "boss.json"),
      `${JSON.stringify(next, null, 2)}\n`,
      "utf-8",
    );
  } catch (error) {
    return { ok: false, message: `写入失败：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, message: `已切换到「${preset.label}」：${next.name}` };
}

/** 当前生效的人格对应哪个预设（比对身份字段；用户手改过则返回 undefined） */
export function currentBossPersonaId(): string | undefined {
  const cur = loadBossPersona();
  return listBossPersonas().find(
    (p) => p.name === cur.name && p.role === cur.role && p.style === cur.style,
  )?.id;
}

const DEFAULT_PERSONA: BossPersona = {
  name: "李广进",
  role: "团队智能助理主管",
  personality:
    "热情、干练、有分寸。能自己答的直接答，专业活儿派给同事并汇总结果。",
  style: "简洁友好，中文回复。",
};

let cache: BossPersona | undefined;
let cacheMtime = 0;

/** 读取 boss 身份配置（server/config/boss.json），mtime 变化自动重载（改名字无需重启） */
export function loadBossPersona(): BossPersona {
  const file = join(config.configDir, "boss.json");
  const overlayFile = join(config.runtimeDir, "boss.json");
  try {
    const mtime = statSync(file).mtimeMs;
    let overlayMtime = 0;
    let overlay: Partial<BossPersona> = {};
    if (existsSync(overlayFile)) {
      overlayMtime = statSync(overlayFile).mtimeMs;
      try {
        overlay = JSON.parse(readFileSync(overlayFile, "utf-8")) as Partial<BossPersona>;
      } catch {
        overlay = {};
      }
    }
    // 组合指纹：内置或运行时覆盖层任一变更都重载（运行时覆盖层优先）
    const combined = mtime + overlayMtime;
    if (!cache || combined !== cacheMtime) {
      cache = {
        ...DEFAULT_PERSONA,
        ...(JSON.parse(readFileSync(file, "utf-8")) as Partial<BossPersona>),
        ...overlay,
      };
      cacheMtime = combined;
    }
  } catch {
    cache ??= DEFAULT_PERSONA;
  }
  return cache;
}

/** 人格指纹：boss.json 变了就换指纹，让带旧人格的历史会话自动作废 */
export function personaKey(p: BossPersona = loadBossPersona()): string {
  return createHash("sha1")
    // employees / avatar 也要进指纹：只改员工称呼的预设同样必须让旧会话失效，
    // 否则 boss 会继续用旧称呼称呼同事
    .update(
      JSON.stringify([p.name, p.role, p.personality, p.style, p.team, p.avatar, p.employees]),
    )
    .digest("hex")
    .slice(0, 8);
}

/**
 * 员工拟人化展示名：server/config/boss.json employees 覆盖 > agent.displayName > 路由名。
 * 所有面向用户的播报都应经过这里。
 */
export function employeeDisplayName(agentName: string): string {
  const override = loadBossPersona().employees?.[agentName];
  if (override) return override;
  return getAgent(agentName)?.displayName ?? agentName;
}

/**
 * 团队名册摘要（单一事实源）：boss 各决策环节（意图分类/路由/直答）统一注入，
 * 避免「一个环节认识小码、另一个环节不认识」的信息不对称。含职责卡（routeHint）。
 */
export function rosterBrief(): string {
  const lines = listRoutableAgents()
    .filter((a) => a.name !== "hr")
    .map(
      (a) =>
        `- ${employeeDisplayName(a.name)}（路由名 ${a.name}）：${a.routeHint ?? a.description}`,
    );
  return lines.length ? lines.join("\n") : "（暂无员工）";
}

/**
 * 结果包装：boss 验收通过后转达员工产出。
 *
 * 只加一行抬头，正文由调用方决定发哪一版：交卷路径发的是主管按 `report-style.md`
 * 组织过的那一段（见 review.ts 的 summary），summary 缺失时回落员工交卷的原始模板。
 *
 * 这里原先的规则是「正文原样透传，boss 再摘要一遍会丢格式、降低信息密度」。
 * 推翻它的是实测：机械模板的密度其实很低——一个修 bug 任务里，用户要的根因与改动被
 * 「为什么拆两步」「我 Bash 了 git diff」这类内部编排稀释，同一个 commit 还重复三遍。
 * 现在的护栏不是「不摘要」，而是摘要时**坐标一字不改 + 只重组已存在的事实**，
 * 且全量模板照旧进任务档案（看板可展开），所以砍显示不等于丢信息。
 *
 * 抬头只占一行：「已完成」这件事说一遍就够，旧版标题 + 署名两行把它说了两遍，
 * 而元信息在 IM 里越短越好——用户真正要看的是下面的正文。
 *
 * taskRef 是「#编号「任务名」」的可读引用（见 task-label.ts）——纯编号在 IM 里
 * 认不出是哪个任务，而编号又必须留着给 /cancel 这类命令定位。
 *
 * 版式说明：钉钉 markdown 只认 `####` 级标题、粗体与引用，`--- ` 这类分割线渲染不出来
 * （会原样显示成文字），所以层级全靠标题 + 引用行撑，不要改回横线分隔。
 * 这里用 `####` 也是为了与 ❓/⚠️/❌ 三种播报（见 boss.ts）保持同一族版式。
 */
export function wrapResult(employeeName: string, taskRef: string, raw: string): string {
  const p = loadBossPersona();
  const display = employeeDisplayName(employeeName);
  return [`#### ✅ ${taskRef} · 「${display}」交付，${p.name} 已验收`, raw].join("\n\n");
}
