import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";

/**
 * 汇报风格手册：主管把员工产出转达给用户前读它，据此决定「这条该怎么写」。
 *
 * 为什么做成用户可编辑的外脑（`presets/report-style.md` → `~/.foreman/report-style.md`）
 * 而不是写死在 prompt 里：「用户想看什么」因人而异也随时间变，写死就得改代码。
 * 与 `team-sop.md` 同一套语义——播种后归用户所有，可改可删。
 *
 * 为什么不按任务类型分模板：任务类型是开放集合（修 bug / 查数 / 装 skill / 改提示词 /
 * 调研 / 运维…），模板永远补不齐，而且每加一类就要动代码。给一份通用规则、让模型自己
 * 判断该怎么组织，才是能覆盖新类型的做法。
 */
const DEFAULT_RULES = [
  "1. 开头第一句就是用户最关心的那件事的结论，不要用背景或复述诉求开头。",
  "2. 信息按「用户接下来要不要做点什么」排序，不按员工干活的顺序排。",
  "3. 只写用户不知道的；他自己提的诉求不要复述，同一个事实只出现一次。",
  "4. 不写内部编排：怎么拆步骤 / 派了谁 / 调了什么工具 / 重试几次 / 评审几轮 / 「我亲自复核了」。",
  "5. 可核验的坐标一字不改地保留：路径、行号、commit、分支、URL、关键数字。",
  "6. 风险只留会改变用户判断或需要他动手的；过程限制（如没装依赖所以没构建）最多一句。",
  "7. 长度自适应：一句话能说完就一句话，别为凑格式硬分段。",
  "8. 只重组产出里已明确存在的事实，不评价、不脑补、不邀功。",
].join("\n");

/**
 * 读汇报风格手册。用户删了文件就回落到内置默认规则——
 * 这条链路每个任务的终态都要走，绝不能因为少一个文件就不汇报。
 */
export function loadReportStyle(): string {
  try {
    const text = readFileSync(join(config.runtimeDir, "report-style.md"), "utf-8").trim();
    if (text) return text;
  } catch {
    /* 未播种 / 被用户删掉 → 用内置默认 */
  }
  return DEFAULT_RULES;
}

/**
 * 挑最终发给用户的文字：优先用主管按风格手册组织过的汇报，缺失时回落员工交卷的原始模板。
 *
 * 回落这条必须留：汇报是模型产物，网关抖动或 JSON 缺字段都可能让它为空，
 * 而「已完成」这件事必须送达用户。宁可发一份啰嗦的机械模板，也不能发空。
 */
export function pickDeliveryText(summary: string | undefined, fallback: string): string {
  const s = summary?.trim();
  return s ? s : fallback;
}
