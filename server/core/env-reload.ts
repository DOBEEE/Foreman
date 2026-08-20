import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { config } from "../config/index.js";

/** 会随轮换更新、需要热重载的鉴权类环境变量 */
const RELOADABLE_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
];

const envFile = join(config.serviceRoot, ".env");

/** 读取 .env 里可热重载的键；文件缺失/异常返回空 */
function readEnvFile(): Record<string, string> {
  try {
    const parsed = parse(readFileSync(envFile, "utf-8"));
    const out: Record<string, string> = {};
    for (const k of RELOADABLE_KEYS) if (parsed[k] != null) out[k] = parsed[k];
    return out;
  } catch {
    return {};
  }
}

/**
 * 轮询 .env，token 轮换后热更新 process.env。
 * 每次 agent 执行都用 `{ ...process.env }` 快照鉴权，更新后的新 query 立即生效，
 * 长期常驻的 serve 进程无需重启即可跟上代理 token 轮换（修复反复 401）。
 * 返回停止函数。
 */
export function startEnvReload(intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    const latest = readEnvFile();
    let changed = false;
    for (const [k, v] of Object.entries(latest)) {
      if (v && process.env[k] !== v) {
        process.env[k] = v;
        changed = true;
      }
    }
    if (changed) {
      console.log(`[env] .env 鉴权信息已热更新（${new Date().toISOString()}）`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
