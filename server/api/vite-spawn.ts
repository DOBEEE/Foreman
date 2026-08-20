import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LOG_DIR } from "../core/logger.js";

export interface SpawnViteOptions {
  /**
   * 静默模式：把 Vite stdio 重定向到日志文件（logs/vite.log）。
   * CLI（Ink）场景下必开，否则 Vite banner 会打到 TTY 上把 Ink 提示符搞乱。
   * serve 场景可关（默认），Vite 输出直出方便看。
   */
  silent?: boolean;
}

/**
 * 后端启动时顺带把前端 dashboard 的 Vite dev server 拉起来（HMR）。
 * - 只在 process.env.AGENT_WEB=vite 时启用（npm run dev / npm run cli 显式打开）
 * - 缺失 web/node_modules 时不阻断主流程，只打印装依赖提示
 * - 主进程退出时一起 kill，避免僵尸 vite 端口占用
 *
 * @param apiPort 后端 HTTP 端口，作为环境变量 API_PORT 传给 web/vite.config.ts 让 proxy 指向真实后端
 * @param opts.silent CLI 场景（Ink 独占 TTY）传 true，把 vite 输出落到日志文件
 * @returns 子进程句柄（可能 undefined：未开启 / 未装依赖）
 */
export function spawnViteDev(
  apiPort: number,
  opts: SpawnViteOptions = {},
): ChildProcess | undefined {
  if (process.env.AGENT_WEB !== "vite") return undefined;

  // web 目录：仓库根 web/（tsx 场景是 <root>/server/api → 上两级仓库根）
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = join(here, "..", "..", "web");
  const viteBin = join(webDir, "node_modules", ".bin", "vite");

  if (!existsSync(viteBin)) {
    console.warn(
      `[web] Vite 未安装：${viteBin} 不存在。先跑 \`npm install --prefix web\`（或 \`npm run build:web\` 后用 npm start 走静态构建）。跳过 Vite。`,
    );
    return undefined;
  }

  // silent：把 vite stdio 重定向到 logs/vite.log，避免搞乱 Ink 的 TTY
  let stdio: "inherit" | ["ignore", number, number] = "inherit";
  let logPath: string | undefined;
  if (opts.silent) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      logPath = join(LOG_DIR, "vite.log");
      const fd = openSync(logPath, "a");
      stdio = ["ignore", fd, fd];
    } catch (e) {
      console.warn("[web] 打开 vite.log 失败，回落 ignore stdio:", e);
      stdio = ["ignore", "ignore", "ignore"] as unknown as "inherit";
    }
  }

  console.log(
    `[web] 启动 Vite dev（proxy /api → :${apiPort}${logPath ? `，日志：${logPath}` : ""}）…`,
  );
  const child = spawn(viteBin, [], {
    cwd: webDir,
    env: { ...process.env, API_PORT: String(apiPort) },
    stdio,
  });

  child.on("exit", (code, signal) => {
    if (code === 0 || signal) return;
    console.warn(`[web] Vite 意外退出 (code=${code})${logPath ? `，看 ${logPath}` : ""}`);
  });

  // 主进程退出联动杀 vite，避免 :5173 占用留着
  const kill = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  process.once("exit", kill);
  process.once("SIGINT", kill);
  process.once("SIGTERM", kill);

  return child;
}

