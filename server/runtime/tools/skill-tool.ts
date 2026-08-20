import { tool } from "ai";
import { z } from "zod";
import { formatSkillsForSystemPrompt, getSkill, listAvailableSkills } from "../skills.js";

/**
 * `Skill` 工具 —— 渐进披露的 L2 激活层：按引用名取回 SKILL.md 正文。
 *
 * 为什么需要它：system prompt 里只放了 name + description 的清单（约 80 token/skill），
 * 正文（中位数约 2000 token，本仓库最大的 yoho-yuque 约 8k token）不预载。
 * 模型判断某技能相关时调这个工具把正文拉进上下文。
 *
 * 工具名沿用 `Skill` —— base-agent 的 PROTOCOL_BUILTINS 早就声明了这个名字
 * （注释写着「Skill 用来加载 plugins 里的技能」），只是一直没人实现。
 *
 * 缓存友好：正文以 tool result 的形式追加在消息末尾，属于 append-only，
 * 会被滚动断点收口，不会破坏 system 那段静态前缀。
 */
export function buildSkillTool() {
  const params = z.object({
    name: z
      .string()
      .describe(
        "技能引用名，取自 system prompt 的技能清单，形如 user:web-search（也接受省略前缀的短名）",
      ),
  });

  return tool({
    description:
      "Load the full instruction manual for a skill by its reference name. " +
      "Call this when the skill catalog in your system prompt lists something relevant to the current task. " +
      "Returns the skill's complete instructions, which you should then follow.",
    inputSchema: params,
    execute: async ({ name }) => {
      const skill = getSkill(name);
      if (!skill) {
        // 返回可用清单而不是干巴巴的「未找到」：模型下一步就能自我纠正，省一轮试错
        const available = listAvailableSkills()
          .map((s) => `- ${s.source}`)
          .join("\n");
        return `未找到技能 "${name}"。当前可用的引用名：\n${available || "（无）"}`;
      }
      return formatSkillsForSystemPrompt([skill]);
    },
  });
}
