import { ASK_USER_TOOL } from "./ask-user.js";

/**
 * 内置 AskUserQuestion 的兜底重定向。
 *
 * boss 派发的任务已经把内置 AskUserQuestion 放进 disallowedTools（模型上下文里看不到它），
 * 正常情况下不会触发。留着它是防止插件/skill/子 agent 绕过 disallowedTools 把它带出来。
 */

export type CanUseTool = (
  toolName: string,
) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;

const REDIRECT_NOTICE = [
  "这个渠道没有交互终端，AskUserQuestion 拿不到用户的回答。",
  `要问用户请改调 ${ASK_USER_TOOL}——它会把问题交给主管转达，用户回答后你会被唤醒继续。`,
  "在拿到答案之前不要替用户挑答案，也不要继续往下做。",
].join("\n");

/** boss 派发任务的提问兜底回调：非提问工具一律放行 */
export function buildAskRelay(): CanUseTool {
  return async (toolName) => {
    if (toolName === "AskUserQuestion") {
      return { behavior: "deny", message: REDIRECT_NOTICE };
    }
    return { behavior: "allow" };
  };
}
