import { acquireLock, releaseLock } from "../channels/lock.js";

/**
 * 评测单飞锁。
 *
 * 为什么需要：多个 foreman 实例可能共用同一个 runtimeDir，而一次评测会
 *   - 把候选提示词临时挂到员工身上（改 hired profile）
 *   - 反复打同一个岗位的 bench 端点
 *   - 往 <runtimeDir>/agent-bench 写 campaign 报告
 * 两次评测并行跑，两边的 runtimeState 会互相污染，分数谁都不可信。
 *
 * 复用渠道那套 pid 存活探测的锁（同一 runtimeDir/locks 目录），**不接管**：
 * 抢锁失败就如实告诉调用方「有人在跑」，而不是把别人的评测杀掉——
 * 一次评测是十几次 LLM 会话，杀掉的代价远大于等它跑完。
 *
 * case 采集不需要这把锁：caseId 内容寻址 + 原子写，天然幂等。
 */
const BENCH_LOCK_KEY = "bench-run";

/**
 * 进程内互斥。文件锁有 `pid !== process.pid` 判断（对渠道场景是对的：同一进程重启
 * 不该把自己锁死），所以它只挡得住跨进程，挡不住同一实例里两个并发调用——
 * 而「定时评测与手动评测撞上」正是真实场景，实测两次并发都能拿到文件锁。
 */
let heldInProcess = false;

export interface BenchLockResult<T> {
  ok: boolean;
  message: string;
  value?: T;
}

/** 拿到锁才执行 fn；拿不到就直接返回 ok:false，不等待、不接管。 */
export async function withBenchLock<T>(fn: () => Promise<T>): Promise<BenchLockResult<T>> {
  if (heldInProcess) {
    return { ok: false, message: "本进程已有评测在跑，本次跳过" };
  }
  const acquired = await acquireLock(BENCH_LOCK_KEY);
  if (!acquired) {
    return { ok: false, message: "已有评测在跑（同一 runtimeDir 只允许一个），本次跳过" };
  }
  heldInProcess = true;
  try {
    return { ok: true, message: "评测完成", value: await fn() };
  } finally {
    heldInProcess = false;
    releaseLock(BENCH_LOCK_KEY);
  }
}
