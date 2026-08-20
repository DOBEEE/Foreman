/**
 * 钉钉 markdown 版式修正。
 *
 * 钉钉的 markdown 渲染里单个 `\n` **不产生换行**——多行文本会被糊成一段。
 * 出站前统一把孤立换行转成硬换行（行尾双空格），已用空行分段的（`\n\n`）保持原样，
 * 避免版式被无谓拉高。
 *
 * 出站的两条路（sessionWebhook 回复 / 主动推送）都要过这里，否则会出现
 * 「同一段文字在回复里有换行、在推送里没换行」的不一致。
 */
export function toDingTalkMarkdown(text: string): string {
  return text.replace(/(?<!\n)\n(?!\n)/g, "  \n");
}

/**
 * 会话列表预览标题。
 * 钉钉把 markdown 消息的 `title` 原样显示在会话列表里，直接截正文前 20 字会漏出
 * `#### ` `**` `>` 这类标记，看起来像乱码。这里剥掉标记后取首行有效内容。
 */
export function previewTitle(text: string, max = 20): string {
  const line =
    text
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s*[#>\-*]+\s*/, "") // 标题/引用/列表前缀
          .replace(/\*\*|__|`/g, "") // 粗体/行内代码
          .replace(/^@\S+\s*/, "") // 群里的 @ 提及
          .trim(),
      )
      .find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line || "消息";
}
