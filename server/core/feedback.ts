import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { LOG_DIR } from "./logger.js";

/**
 * 用户反馈记录。
 *
 * 为什么需要它：复盘师吃「员工笔记 + trace」，优化师吃「traces + runs」，
 * 全是**内部信号**；而 boss 的验收又是同一个模型家族的自我评判，错误方向系统性相关。
 * 于是会出现「任务标 done、验收说已修复，用户紧接着说还是不行」而复盘毫无察觉的情况。
 * 用户反馈是这条闭环里**唯一的外部真相**。
 *
 * 使用纪律（写给消费方，也写给未来改这段代码的人）：
 * - 反馈是**待核查的线索，不是分数**。绝不能让优化去「最大化正反馈」——
 *   那会把员工训练成讨用户开心，而不是把事做对。
 * - 结论必须能在 trace 里对上；与 trace 冲突时以 trace 为准（与笔记同一条规矩）。
 * - **负反馈的信息量远大于正反馈**：用户说「好」可能只是客气、或当时还没发现问题。
 * - 归属拿不准就留空 taskId/agentName，**不要猜**——归错人比没记录更有害。
 */
export interface FeedbackRecord {
  time: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
  polarity: "positive" | "negative";
  /**
   * 信号来源：
   * - explicit：用户话里明确表达的满意/不满（旁路廉价分类器识别，见 feedback-classifier.ts）
   * - cancel：用户取消了任务（行为信号，比嘴上说的更硬）
   * - proposal_rejected：用户驳回了优化提案（优化师自身看错了）
   */
  signal: "explicit" | "cancel" | "proposal_rejected";
  /** 归属任务；判定不明时留空 */
  taskId?: string;
  /** 被反馈的员工路由名；归属不明时留空 */
  agentName?: string;
  /** 关联执行会话，便于消费方回到 trace 核对 */
  sessionId?: string;
  /** 用户原话（explicit 时保留，供复盘判断语气与具体不满点） */
  text?: string;
  /**
   * 现场上下文快照，供交叉核对：
   * 例如 bossAssists>0 且收到负反馈 → 很可能是 boss 代答答错了，而非员工的问题。
   */
  context?: {
    state?: string;
    bossAssists?: number;
    reassigns?: number;
    autoContinues?: number;
  };
}

/** 当天反馈文件路径（复盘/优化的提示词里直接给出，让它们自己 Read/Grep） */
export function feedbackFile(date: string): string {
  return `${LOG_DIR}feedback-${date}.jsonl`;
}

/** 追加一条反馈，写失败仅告警（绝不影响主流程） */
export function appendFeedback(record: FeedbackRecord): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(feedbackFile(record.time.slice(0, 10)), `${JSON.stringify(record)}\n`);
    console.log(
      `[feedback] ${record.polarity}/${record.signal}` +
        `${record.agentName ? ` agent=${record.agentName}` : ""}${record.taskId ? ` task=${record.taskId}` : ""}`,
    );
  } catch (error) {
    console.warn("[feedback] 写反馈日志失败:", error);
  }
}

/** 当天是否有反馈文件（消费方据此决定要不要在提示词里提这个数据源） */
export function hasFeedback(date: string): boolean {
  return existsSync(feedbackFile(date));
}

/**
 * 当天是否有针对某员工的反馈。复盘据此决定「没新 run 但被用户吐槽了」的岗位也要复盘——
 * 负反馈是复盘最高价值的素材，绝不能因为当天没派新活就跳过。
 * fail-open：读不到/损坏一律 false（跳过方向安全，见 agentActiveOn 同款理由）。
 */
export function hasFeedbackFor(agentName: string, date: string): boolean {
  let content: string;
  try {
    content = readFileSync(feedbackFile(date), "utf-8");
  } catch {
    return false;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      if ((JSON.parse(line) as FeedbackRecord).agentName === agentName) return true;
    } catch {
      // 损坏行跳过
    }
  }
  return false;
}
