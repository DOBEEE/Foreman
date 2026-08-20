import type { Task } from "./types.js";

/**
 * 任务的一句话名字：让「#8cf5c7」这种纯编号在 IM 里变得能认出来。
 *
 * 编号必须保留（`/cancel 8cf5c7`、`#8cf5c7 继续` 这些命令都靠它定位），
 * 所以这里是「编号 + 名字」而不是用名字替掉编号。
 *
 * 取名优先级：派工简报的「目标：」行 > 用户原话首句。
 * 简报是主管分诊时提炼过的，比用户原话更贴近「这活儿是什么」；
 * 但要跳过「套用：<模板名>」那行——那是给组长看的编队指令，不是任务名。
 */

/** 简报里跳过的行：编队模板指令，不是任务内容 */
const SKIP_BRIEF_LINE = /^(套用|模板)[:：]/;

/**
 * 截断到 max 字，但**不从英文单词/数字中间切断**——
 * 「mobiledescript…」这种截法比截短更难认。落在单词内时回退到最近的非字母数字边界；
 * 回退幅度上限为 max 的 1/3，避免为了对齐边界把标题砍得太短。
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const word = /[A-Za-z0-9]/;
  let cut = max;
  if (word.test(text[cut - 1] ?? "") && word.test(text[cut] ?? "")) {
    const floor = Math.max(1, max - Math.floor(max / 3));
    let back = cut;
    while (back > floor && word.test(text[back - 1] ?? "")) back--;
    if (back > floor) cut = back;
  }
  return `${text.slice(0, cut).trimEnd()}…`;
}

function firstSentence(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  // 按句末标点切第一句：IM 里一行太长会被折行，读起来反而更难认
  const head = oneLine.split(/(?<=[。！？!?；;])/)[0] || oneLine;
  const s = head.replace(/[。！？!?；;]\s*$/, "");
  return clip(s, max);
}

/** 一句话任务名（不含编号）。派生不出内容时返回空串 */
export function taskTitle(
  task: Pick<Task, "brief" | "prompt">,
  max = 20,
): string {
  const briefLines = (task.brief ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !SKIP_BRIEF_LINE.test(l));
  const goal = briefLines
    .find((l) => /^目标[:：]/.test(l))
    ?.replace(/^目标[:：]\s*/, "");
  const source = goal || briefLines[0] || task.prompt || "";
  return firstSentence(source, max);
}

/**
 * 面向用户的任务引用：`#8cf5c7「修复发布页组件提交问题」`。
 * 派生不出名字时退回纯 `#8cf5c7`（不硬造名字，也不留空引号）。
 */
export function taskRef(
  task: Pick<Task, "id" | "brief" | "prompt">,
  max = 20,
): string {
  const title = taskTitle(task, max);
  return title ? `#${task.id}「${title}」` : `#${task.id}`;
}
