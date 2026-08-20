/**
 * 系统触发的 boss 轮次预算。
 *
 * 为什么需要：单一大脑后，任务失败/完成/交接都会唤醒 boss 做一次 LLM 推理。
 * 失控场景（循环失败、大批量任务完成）可能一小时内连唤几十次，token 爆炸。
 * 预算控制确保在极端情况下自动降级到旧路径（bossThink 窄调用），不停摆。
 *
 * 策略：滚动窗口（1 小时），per-chat 独立。用户消息始终放行不受限制。
 */

// ─── Configuration ────────────────────────────────────────────

export interface BudgetConfig {
  maxSystemTurnsPerHour: number;
  maxSystemTokensPerHour: number;
  /** 预算耗尽后冷却（ms），冷却期间系统事件走降级 */
  cooldownMs: number;
}

const DEFAULT_CONFIG: BudgetConfig = {
  maxSystemTurnsPerHour: 30,
  maxSystemTokensPerHour: 100_000,
  cooldownMs: 300_000, // 5 分钟
};

let cfg: BudgetConfig = { ...DEFAULT_CONFIG };

export function configureBudget(override: Partial<BudgetConfig>): void {
  cfg = { ...DEFAULT_CONFIG, ...override };
}

// ─── State ────────────────────────────────────────────────────

interface BudgetEntry {
  timestamp: number;
  tokens: number;
}

/** per-chat 滚动窗口 */
const windows = new Map<string, BudgetEntry[]>();

/** 冷却截止时间 per-chat */
const cooldownUntil = new Map<string, number>();

const HOUR_MS = 3600_000;

// ─── Public API ───────────────────────────────────────────────

/** 系统事件能否唤醒 boss（用户消息不走这里，始终放行） */
export function canSystemTrigger(chatId: string, now = Date.now()): boolean {
  // 冷却中直接拒
  const cd = cooldownUntil.get(chatId);
  if (cd && now < cd) return false;

  const entries = prune(chatId, now);
  if (entries.length >= cfg.maxSystemTurnsPerHour) return false;

  const totalTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
  if (totalTokens >= cfg.maxSystemTokensPerHour) return false;

  return true;
}

/** 记录一次系统触发的 boss turn（turn 结束后调用） */
export function recordSystemTurn(chatId: string, tokens: number, now = Date.now()): void {
  const entries = prune(chatId, now);
  entries.push({ timestamp: now, tokens });
  windows.set(chatId, entries);

  // 检查是否触发冷却
  if (entries.length >= cfg.maxSystemTurnsPerHour) {
    cooldownUntil.set(chatId, now + cfg.cooldownMs);
  }
  const totalTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
  if (totalTokens >= cfg.maxSystemTokensPerHour) {
    cooldownUntil.set(chatId, now + cfg.cooldownMs);
  }
}

/** 当前预算使用状态（供 situation 展示 / 调试） */
export function budgetStatus(chatId: string, now = Date.now()): {
  turnsUsed: number;
  turnsMax: number;
  tokensUsed: number;
  tokensMax: number;
  cooling: boolean;
  cooldownRemainingMs: number;
} {
  const entries = prune(chatId, now);
  const cd = cooldownUntil.get(chatId);
  const cooling = cd ? now < cd : false;
  return {
    turnsUsed: entries.length,
    turnsMax: cfg.maxSystemTurnsPerHour,
    tokensUsed: entries.reduce((sum, e) => sum + e.tokens, 0),
    tokensMax: cfg.maxSystemTokensPerHour,
    cooling,
    cooldownRemainingMs: cooling && cd ? cd - now : 0,
  };
}

/** 测试用：重置 */
export function _resetForTest(): void {
  windows.clear();
  cooldownUntil.clear();
  cfg = { ...DEFAULT_CONFIG };
}

// ─── Internal ─────────────────────────────────────────────────

/** 清理超出 1 小时窗口的条目，返回当前有效条目 */
function prune(chatId: string, now: number): BudgetEntry[] {
  const entries = windows.get(chatId) ?? [];
  const cutoff = now - HOUR_MS;
  const valid = entries.filter((e) => e.timestamp > cutoff);
  windows.set(chatId, valid);
  return valid;
}
