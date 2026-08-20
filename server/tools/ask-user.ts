/**
 * 提问工具常量。
 *
 * 实际 tool 实现在 server/runtime/tools/protocol-tools.ts (buildAskUserTool)。
 * 本文件仅保留业务常量（工具名），供 boss/agents 层引用。
 */

/** 工具在 Vercel AI inline tools 中的注册名（= protocolTools 的 key） */
export const ASK_USER_TOOL = "ask_user";
