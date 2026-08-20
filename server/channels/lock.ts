import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { config } from "../config/index.js";

const lockDir = join(config.runtimeDir, "locks");

function lockFile(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 16);
  return join(lockDir, `${hash}.lock`);
}

/** 进程是否存活（signal 0 只探测不发信号） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH=不存在→死；EPERM=存在但无权限→当作活着
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读进程命令行（macOS/Linux 通用 ps -o command=）；失败返回空串 */
function processCmdline(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    // argv 数组避免 shell 拼接注入（pid 已强类型校验，但 argv 方式更稳）
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * 判断某 pid 是否像本项目的 foreman 进程（避免误杀 pid 复用的其它进程）。
 * 只对命令行里出现项目相关路径或入口关键词的才允许接管。
 */
function looksLikeForeman(cmd: string): boolean {
  if (!cmd) return false;
  if (cmd.includes("foreman") || cmd.includes("agent-base")) return true;
  // 入口特征：源码 server/index.ts（dev / cli）或构建产物 dist/index.js（start）
  if (/\/server\/index\.ts\b/.test(cmd)) return true;
  if (/\/dist\/index\.js\b/.test(cmd)) return true;
  if (/\btsx\b.*\bserver\/index\b/.test(cmd)) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitDead(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

export interface AcquireOptions {
  /**
   * 若锁被另一 foreman 进程持有：true=SIGTERM 优雅停+SIGKILL 兜底后接管；
   * false（默认）=直接返回 false 让调用方跳过。
   * 命令行不像 foreman（怀疑 pid 被无关进程复用）时**不接管**、返回 false。
   */
  takeover?: boolean;
}

/**
 * 尝试获取单实例锁：成功返回 true 并写入本进程 pid；
 * 已被活进程持有：默认返回 false；opts.takeover=true 时尝试接管
 * （只对确认是 foreman 的持有者动手，先 SIGTERM 3s 再 SIGKILL）。
 * 持有者已死（stale）则直接接管。
 * 用于「同一钉钉 token 全局只允许一个监听」。
 */
export async function acquireLock(
  key: string,
  opts: AcquireOptions = {},
): Promise<boolean> {
  try {
    mkdirSync(lockDir, { recursive: true });
    const file = lockFile(key);
    let holder: number | undefined;
    let held = false;
    try {
      const raw = readFileSync(file, "utf-8").trim();
      const pid = Number(raw);
      // pid 必须是正整数：空串会被 Number 解析成 0，而 kill(0, 0) 探测的是当前
      // 进程组、恒为真，会把空/损坏锁文件误判成「被 pid=0 持有」并永久阻塞接管
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
        holder = pid;
        held = true;
      }
    } catch {
      // 无锁文件，走 acquire
    }

    if (held && holder !== undefined) {
      if (!opts.takeover) return false;
      const cmd = processCmdline(holder);
      if (!looksLikeForeman(cmd)) {
        console.warn(
          `[lock] 锁被非 foreman 进程 pid=${holder} 持有（"${cmd.slice(0, 80)}"），拒绝接管`,
        );
        return false;
      }
      console.log(
        `[lock] 接管旧持有者 pid=${holder}（${cmd.slice(0, 60)}），发送 SIGTERM…`,
      );
      try {
        process.kill(holder, "SIGTERM");
      } catch {
        /* 已死 */
      }
      if (!(await waitDead(holder, 3000))) {
        console.warn(`[lock] pid=${holder} 3s 未退出，发送 SIGKILL`);
        try {
          process.kill(holder, "SIGKILL");
        } catch {
          /* ignore */
        }
        await waitDead(holder, 1000);
      }
      if (pidAlive(holder)) {
        console.warn(`[lock] pid=${holder} 无法结束，放弃接管`);
        return false;
      }
      console.log(`[lock] 旧持有者已退出，接管锁`);
      // 关键：让上游（如钉钉服务端）意识到旧连接已断，避免立即重连被判"重复会话"401
      await sleep(2000);
    }

    writeFileSync(file, String(process.pid));
    return true;
  } catch {
    // 锁机制异常时保守放行（不因锁故障阻断启动）
    return true;
  }
}

/** 释放锁：仅当锁归属本进程时删除 */
export function releaseLock(key: string): void {
  try {
    const file = lockFile(key);
    const holder = Number(readFileSync(file, "utf-8").trim());
    if (holder === process.pid) rmSync(file, { force: true });
  } catch {
    // 忽略
  }
}
