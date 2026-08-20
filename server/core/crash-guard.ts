/**
 * 全局崩溃兜底。
 *
 * 存在的理由：foreman 是常驻的主管进程，它同时挂着渠道连接（钉钉 Stream）、任务队列、
 * 定时调度和一堆外部 MCP server。这些外部依赖**必然**会抛错——某个 MCP server 的
 * axios 20s 超时、某个 npx 包自己没处理 promise、某个上游网关抽风。
 *
 * Node 15+ 起，未被捕获的 promise rejection **会直接终止进程**。于是一次
 * 「open-websearch 抓 README 超时」就能把整个主管杀掉：渠道断连、排队任务全丢、
 * 用户发消息没人应答。这是不可接受的——单个工具调用的失败绝不该等于服务下线。
 *
 * 分级策略（刻意不同）：
 * - **unhandledRejection：永不退出**。一条 promise 链失败的作用域就是那条链，
 *   进程状态没有被污染。记日志、继续跑。这是本模块的主要目标。
 * - **uncaughtException：记日志后继续，但计数**。Node 官方警告此时进程状态
 *   可能已不一致，所以设一个「短时间内反复抛」的闸门：真出现雪崩（状态确实坏了）
 *   就主动退出，交给外层 supervisor 重启；偶发单次则扛住不倒。
 *
 * 必须在入口**最早期**装载：装载点之后才被覆盖的错误才拦得住。
 */

/** 短时间内 uncaughtException 达到此数即认为进程状态已损坏，主动退出让外层重启 */
const FATAL_BURST_THRESHOLD = 5;
/** 计数窗口（ms）：超出窗口的历史记录不计入雪崩判定 */
const FATAL_BURST_WINDOW_MS = 10_000;

/** 同一错误签名的去重窗口：窗口内重复出现只上报一次（但仍累计次数） */
const DEDUPE_WINDOW_MS = 600_000; // 10 分钟
/** 上报节流：每小时最多惊动 boss 这么多次，防噪音与烧 token */
const REPORT_MAX_PER_HOUR = 6;
const HOUR_MS = 3_600_000;

/** uncaughtException 的发生时间戳（滚动窗口） */
const exceptionTimestamps: number[] = [];

/** 错误签名 → { 首次上报时间, 累计次数 }，用于去重 */
const seenSignatures = new Map<string, { reportedAt: number; count: number }>();

/** 上报时间戳（滚动窗口），用于节流 */
const reportTimestamps: number[] = [];

let installed = false;

/**
 * 上报回调。由 boss 层在启动时注册（依赖倒置：core 不能 import boss，否则循环依赖）。
 * 未注册时只记日志——CLI 一次性命令、单测等场景本来就不需要 boss 介入。
 */
export type CrashReporter = (report: {
  source: "unhandled_rejection" | "uncaught_exception";
  errorText: string;
  occurrences: number;
}) => void;

let reporter: CrashReporter | undefined;

/**
 * 递归抑制开关。
 *
 * 最危险的路径：boss 处理 system_error 时它自己的工具又抛错 → 又上报 → 又唤醒 boss → 无限循环。
 * boss 层在处理 system_error 事件期间把这个开关打开，期间捕获的错误只记日志不上报。
 */
let reportingSuppressed = false;

export function setCrashReporter(fn: CrashReporter): void {
  reporter = fn;
}

/** boss 处理基础设施错误期间调用，防止自激循环 */
export function suppressCrashReporting(): void {
  reportingSuppressed = true;
}

export function resumeCrashReporting(): void {
  reportingSuppressed = false;
}

/** 把错误渲染成可读文本（Error 取 stack，其余走 String） */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * 错误签名：用于去重。取 name + message 的首行，**不含 stack**——
 * 同一个故障在不同调用点的 stack 不同，含 stack 会让去重完全失效。
 */
function signatureOf(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}:${(error.message ?? "").split("\n")[0].slice(0, 200)}`;
  }
  return String(error).split("\n")[0].slice(0, 200);
}

/** 清理过期的去重记录 */
function pruneSignatures(now: number): void {
  for (const [sig, rec] of seenSignatures) {
    if (now - rec.reportedAt > DEDUPE_WINDOW_MS) seenSignatures.delete(sig);
  }
}

/**
 * 决定这次错误要不要上报给 boss，并返回累计出现次数。
 *
 * 三层过滤（缺一层就可能雪崩或刷屏）：
 * 1. 递归抑制：boss 正在处理错误时不再上报
 * 2. 签名去重：同一故障 10 分钟内只惊动一次
 * 3. 小时节流：无论多少种错误，每小时最多 6 次
 */
function shouldReport(error: unknown, now: number): { report: boolean; occurrences: number } {
  const sig = signatureOf(error);
  pruneSignatures(now);

  const existing = seenSignatures.get(sig);
  if (existing) {
    existing.count += 1;
    // 同签名已上报过 → 只累计不再惊动 boss
    return { report: false, occurrences: existing.count };
  }

  if (reportingSuppressed) {
    // 不登记签名：抑制期结束后如果还在发生，应该有机会被上报
    return { report: false, occurrences: 1 };
  }

  // 小时节流
  while (reportTimestamps.length > 0 && now - reportTimestamps[0] > HOUR_MS) {
    reportTimestamps.shift();
  }
  if (reportTimestamps.length >= REPORT_MAX_PER_HOUR) {
    return { report: false, occurrences: 1 };
  }

  seenSignatures.set(sig, { reportedAt: now, count: 1 });
  reportTimestamps.push(now);
  return { report: true, occurrences: 1 };
}

/** 上报给 boss；reporter 自己抛错绝不能再冒出来（否则就是我们制造了新的崩溃） */
function reportSafely(
  source: "unhandled_rejection" | "uncaught_exception",
  error: unknown,
  occurrences: number,
): void {
  if (!reporter) return;
  try {
    reporter({ source, errorText: describe(error).slice(0, 2000), occurrences });
  } catch (e) {
    console.error("[crash-guard] 上报给 boss 失败（已忽略，不再向上抛）:", e);
  }
}

/**
 * 判断是否为「启动期就该直接死」的致命错误。
 *
 * 这类错误扛住毫无意义：端口被占用时服务根本没起来，硬撑着只会让用户以为在跑。
 */
function isFatalStartupError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === "EADDRINUSE" || code === "EACCES";
}

/**
 * 装载全局兜底。重复调用无副作用（幂等）。
 */
export function installCrashGuard(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    // 永不退出：一条 promise 链的失败不该带走整个主管进程。
    // 最常见来源是外部 MCP server / 上游网关的超时，与本进程状态无关。
    console.error(
      "[crash-guard] 未捕获的 promise rejection（已拦下，服务继续运行）:\n" + describe(reason),
    );
    const { report, occurrences } = shouldReport(reason, Date.now());
    if (report) reportSafely("unhandled_rejection", reason, occurrences);
  });

  process.on("uncaughtException", (error) => {
    if (isFatalStartupError(error)) {
      console.error("[crash-guard] 启动期致命错误，退出:\n" + describe(error));
      process.exit(1);
    }

    const now = Date.now();
    exceptionTimestamps.push(now);
    // 只保留窗口内的记录
    while (exceptionTimestamps.length > 0 && now - exceptionTimestamps[0] > FATAL_BURST_WINDOW_MS) {
      exceptionTimestamps.shift();
    }

    if (exceptionTimestamps.length >= FATAL_BURST_THRESHOLD) {
      console.error(
        `[crash-guard] ${FATAL_BURST_WINDOW_MS / 1000}s 内连续 ${exceptionTimestamps.length} 次未捕获异常，` +
          `判定进程状态已损坏，退出以便重启:\n` + describe(error),
      );
      process.exit(1);
    }

    console.error(
      `[crash-guard] 未捕获异常（已拦下，服务继续运行；窗口内第 ${exceptionTimestamps.length}/${FATAL_BURST_THRESHOLD} 次）:\n` +
        describe(error),
    );
    const { report, occurrences } = shouldReport(error, now);
    if (report) reportSafely("uncaught_exception", error, occurrences);
  });
}

/** 测试用：当前窗口内的异常计数 */
export function _exceptionBurstCount(): number {
  return exceptionTimestamps.length;
}

/** 测试用：重置 */
export function _resetForTest(): void {
  exceptionTimestamps.length = 0;
  seenSignatures.clear();
  reportTimestamps.length = 0;
  reportingSuppressed = false;
  reporter = undefined;
}
