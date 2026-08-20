/**
 * in-flight 执行注册表：chatId:taskId → 打断手柄。
 *
 * 独立成模块是为了**打破循环依赖**：boss.ts 要用临时工模块（派发时刷新活跃时间、
 * 验收通过后发转正提案），临时工模块辞退时又要打断在跑的 run。谁 import 谁都成环，
 * 于是把两边都需要的这一小块状态放到下游。
 */

interface InflightRun {
  controller: AbortController;
  /** 置 true 表示是用户主动打断：执行方静默退出，不判失败、不动任务状态 */
  interrupted: boolean;
}

const inflight = new Map<string, InflightRun>();

function key(chatId: string, taskId: string): string {
  return `${chatId}:${taskId}`;
}

/** 注册一个 run，返回注销函数（只注销自己那次，避免误删后来者） */
export function registerRun(
  chatId: string,
  taskId: string,
  run: InflightRun,
): () => void {
  const k = key(chatId, taskId);
  inflight.set(k, run);
  return () => {
    if (inflight.get(k) === run) inflight.delete(k);
  };
}

export function getRun(chatId: string, taskId: string): InflightRun | undefined {
  return inflight.get(key(chatId, taskId));
}

/**
 * 打断某任务的 in-flight 执行。返回是否真的打断了一个正在跑的 run
 * （false = 没有活跃执行，例如任务是重启后恢复的 running 态）。
 */
export function interruptRun(chatId: string, taskId: string): boolean {
  const rec = inflight.get(key(chatId, taskId));
  if (!rec) return false;
  rec.interrupted = true;
  rec.controller.abort();
  return true;
}

export type { InflightRun };
