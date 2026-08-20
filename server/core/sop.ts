import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";

/**
 * 团队 SOP 触发索引。
 *
 * 存在的理由：SOP 手册（team-sop.md）原先只有**组长**读得到，boss 完全不知道
 * 「修 bug 其实是『实现 + 评审』两步」，于是每次都把它当单人活派给 coder——
 * 手册写得再好也没机会被用上。这里把「什么任务该编队」这一小段提取出来给 boss 看，
 * 手册正文仍然只给组长（boss 不需要知道每步 brief 怎么写）。
 *
 * 单一事实源：索引就写在 team-sop.md 里的 ```json 代码块中，用户改手册即改路由。
 * 手册被删 / 代码块缺失 / 解析失败 → 返回空，boss 退回「派单人」的老行为
 * （与手册里「删了组长就只靠自己的判断编队」的约定一致，只是退化范围更大一点）。
 */
export interface SopTrigger {
  /** 模板名，写进 brief 交给组长，让它别再从头推导 */
  template: string;
  /** 命中条件（给 boss 判断用的自然语言） */
  when: string;
  /** 步骤概要，让 boss 明白这活儿为什么需要多人 */
  steps: string;
}

interface SopIndex {
  triggers?: SopTrigger[];
  /** 明确不该编队的情形（琐碎改动等），避免为了流程而流程 */
  exceptions?: string[];
}

function sopFile(): string {
  return join(config.runtimeDir, "team-sop.md");
}

/** mtime 缓存：每次派工都重读重解析这份手册是白花开销 */
let cache: { mtimeMs: number; index: SopIndex } | undefined;

/** 从手册里抽第一个 ```json 代码块解析成索引 */
export function loadSopIndex(): SopIndex {
  const file = sopFile();
  let text: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.index;
    text = readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  const index = parseSopIndex(text, file);
  cache = { mtimeMs, index };
  return index;
}

function parseSopIndex(text: string, file: string): SopIndex {
  const block = text.match(/```json\s*([\s\S]*?)```/);
  if (!block) {
    console.warn(
      `[sop] ${file} 里没有 \`\`\`json 触发索引代码块，boss 将不会主动编队（退回派单人）`,
    );
    return {};
  }
  try {
    const parsed = JSON.parse(block[1]) as SopIndex;
    const triggers = (parsed.triggers ?? []).filter(
      (t) => t?.template && t?.when && t?.steps,
    );
    return {
      triggers,
      ...(parsed.exceptions?.length ? { exceptions: parsed.exceptions } : {}),
    };
  } catch (error) {
    console.warn("[sop] 触发索引解析失败，boss 将不会主动编队:", error);
    return {};
  }
}

/**
 * 渲染给 boss 派工提示词的 SOP 段。没有可用索引时返回空串——
 * 调用方据此完全省略该段，而不是塞一句「暂无 SOP」去干扰判断。
 */
export function sopRoutingBrief(): string {
  const { triggers, exceptions } = loadSopIndex();
  if (!triggers?.length) return "";
  const lines = triggers.map(
    (t) => `- **${t.template}**：当「${t.when}」→ 步骤约为 ${t.steps}`,
  );
  return [
    "## 团队 SOP（命中即编队，交给 lead）",
    "以下任务类型**按团队规范需要多名同事接力**，必须派给 `lead`（编队组长）而不是某个单人，",
    "并在 brief 里写明命中的模板名（组长会据此套模板，不必从头推导）：",
    ...lines,
    exceptions?.length
      ? `\n**例外（仍派单人，不要编队）**：\n${exceptions.map((e) => `- ${e}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
