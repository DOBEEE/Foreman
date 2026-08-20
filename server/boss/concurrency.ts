/**
 * 全局并发闸门：限制整个实例同时执行的 run 数，防高并发打爆资源。
 * 与 per-chat 队列正交——队列管「同会话谁先谁后」，闸门管「全实例最多几个在跑」。
 * 关键约定：只在「真正在跑」时持令牌；任务转 waiting_user（等用户回答）必须先 release，
 * 否则 waiting 任务攥着令牌不放会导致令牌耗尽、实例死锁。
 */
export class Semaphore {
  private inFlight = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight++;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  /** 当前在跑数 / 等待数，用于 /status 或监控 */
  stats(): { inFlight: number; waiting: number; max: number } {
    return { inFlight: this.inFlight, waiting: this.waiters.length, max: this.max };
  }
}
