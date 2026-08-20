import type { Task } from "./types.js";

/**
 * 确定性意图片段。
 *
 * 只有这三类：归属已经明确写在文本里，用正则就能 100% 判准，没必要花一次 LLM。
 * 其余所有消息一律交给 boss agent（会话是入口，派活/转达/取消都是它的工具）。
 */
export type IntentSegment =
  | { kind: "reply"; taskId: string; content: string }
  | { kind: "task_op"; op: "status" }
  | { kind: "task_op"; op: "cancel"; taskId: string }
  | {
      /** 提示词优化提案审批（优化员产出 → 主管推送 → 用户一句话决定） */
      kind: "proposal_op";
      op: "list";
    }
  | { kind: "proposal_op"; op: "apply" | "reject" | "revert"; proposalId: string }
  | { kind: "case_op"; op: "list" }
  | { kind: "case_op"; op: "approve" | "discard"; caseRef: string };

const CANCEL_RE = /^\/?cancel\s+#?([\w-]+)/i;
const STATUS_RE = /^\/?status\b/i;
/** 提案审批：确定性匹配，零 LLM。批准 <id> / 驳回 <id> / 回退 <id> / 提案（列清单） */
const PROPOSAL_APPLY_RE = /^(?:\/apply\s+|批准|同意|应用)\s*#?([\w-]+)$/i;
const PROPOSAL_REJECT_RE = /^(?:\/reject\s+|驳回|拒绝|不要)\s*#?([\w-]+)$/i;
const PROPOSAL_REVERT_RE = /^(?:\/revert\s+|回退|还原|撤销)\s*#?([\w-]+)$/i;
const PROPOSAL_LIST_RE =
  /^(?:\/proposals?|(?:待审|优化)?提案(?:清单)?|有哪些提案|优化建议)\s*$/i;
/**
 * 待审回归用例（case）的审批。
 *
 * 必须与提案分开，而且必须**先于**提案正则匹配：caseId 形如 `assistant-1a2b3c4d`，
 * 一个裸的「批准 assistant-1a2b3c4d」会被提案正则吃掉，然后报「没找到提案」。
 * 所以用例审批要求带 `用例`/`case` 字样，语义上也更清楚 —— 批准的是一条**评测标准**，
 * 不是一次改动。
 */
const CASE_APPROVE_RE = /^(?:\/case-approve\s+|批准(?:用例|case)|(?:用例|case)批准)\s*#?([\w/-]+)$/i;
const CASE_DISCARD_RE = /^(?:\/case-discard\s+|驳回(?:用例|case)|(?:用例|case)驳回)\s*#?([\w/-]+)$/i;
const CASE_LIST_RE = /^(?:\/cases?|待审(?:用例|case)(?:清单)?|有哪些待审用例)\s*$/i;
/**
 * 「#任务号 回答内容」：答题卡按钮回填的格式，也是用户手动指名任务的推荐写法。
 * 只在任务号确实命中待确认任务时才走这条快路径，避免吞掉正常的以 # 开头的消息
 * （如 markdown 标题、「#3 这个方案更好」这类泛指）。
 */
const TASK_REPLY_RE = /^#([\w-]+)[\s，,：:]+([\s\S]+)$/;

/** 确定性前置匹配：纯正则，零 LLM。命中则返回片段，未命中返回 undefined（→ 交给 agent）。 */
export function matchDeterministicIntent(
  text: string,
  waiting: Task[],
): { segments: IntentSegment[] } | undefined {
  const trimmed = text.trim();

  const cancelMatch = trimmed.match(CANCEL_RE);
  if (cancelMatch) return { segments: [{ kind: "task_op", op: "cancel", taskId: cancelMatch[1] }] };
  if (STATUS_RE.test(trimmed)) return { segments: [{ kind: "task_op", op: "status" }] };

  // case 先匹配：caseId 形如 assistant-1a2b3c4d，裸「批准 <id>」会被提案正则吃掉
  const caseApprove = trimmed.match(CASE_APPROVE_RE);
  if (caseApprove) return { segments: [{ kind: "case_op", op: "approve", caseRef: caseApprove[1] }] };
  const caseDiscard = trimmed.match(CASE_DISCARD_RE);
  if (caseDiscard) return { segments: [{ kind: "case_op", op: "discard", caseRef: caseDiscard[1] }] };
  if (CASE_LIST_RE.test(trimmed)) return { segments: [{ kind: "case_op", op: "list" }] };

  const applyMatch = trimmed.match(PROPOSAL_APPLY_RE);
  if (applyMatch) return { segments: [{ kind: "proposal_op", op: "apply", proposalId: applyMatch[1] }] };
  const rejectMatch = trimmed.match(PROPOSAL_REJECT_RE);
  if (rejectMatch) return { segments: [{ kind: "proposal_op", op: "reject", proposalId: rejectMatch[1] }] };
  const revertMatch = trimmed.match(PROPOSAL_REVERT_RE);
  if (revertMatch) return { segments: [{ kind: "proposal_op", op: "revert", proposalId: revertMatch[1] }] };
  if (PROPOSAL_LIST_RE.test(trimmed)) return { segments: [{ kind: "proposal_op", op: "list" }] };

  // 答题卡按钮点击 → 「#任务号 选项」。归属已在文本里写明，不必再花一次 LLM 去猜
  const replyMatch = trimmed.match(TASK_REPLY_RE);
  if (replyMatch && waiting.some((t) => t.id === replyMatch[1])) {
    return { segments: [{ kind: "reply", taskId: replyMatch[1], content: replyMatch[2].trim() }] };
  }

  return undefined;
}
