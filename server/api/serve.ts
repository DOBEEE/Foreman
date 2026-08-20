import { config } from "../config/index.js";
import { mirrorConsoleToFile } from "../core/logger.js";
import { backfillFromMessageLogs } from "../core/chat-store.js";
import { createApp } from "./http.js";
import { spawnViteDev } from "./vite-spawn.js";
import { startBossRuntime } from "../boot/boss-runtime.js";
import {
  bindHost,
  dashboardUrl,
  dashboardUrlWithToken,
  hasUsableModel,
  startupGuidance,
  verifyCredential,
} from "../core/onboarding.js";

/** 云端/常驻模式：HTTP 服务 + 全部渠道（钉钉 Stream 等） */
export async function startServe(): Promise<void> {
  // 控制台输出落盘（logs/server-YYYY-MM-DD.log），运行期报错可回查。
  // 必须在 createApp 之前：createApp 自己会打启动日志，晚了就落不下来。
  mirrorConsoleToFile();

  // 首启回填历史会话：钉钉侧拉不到历史消息，只能用我们自己记的审计日志重建（幂等）
  const filled = backfillFromMessageLogs();
  if (filled) {
    console.log(
      `[chat-store] 已从审计日志回填 ${filled.chats} 个会话、${filled.messages} 条消息`,
    );
  }

  const app = createApp();

  // 只绑回环（除非显式开了 lan 或配了 token）：localhostOnly 是应用层守卫，
  // 它挡请求但不关端口，而看板能配凭据、能改岗位提示词，端口不该对全网开着
  const host = bindHost();
  const server = app.listen(config.port, host, () => {
    console.log(`agent server listening on http://localhost:${config.port}（bind ${host}）`);
    console.log(`  POST http://localhost:${config.port}/api/agents/:name/run  (SSE/JSON)`);
    console.log(`  GET  http://localhost:${config.port}/api/agents`);
    console.log(`  GET  http://localhost:${config.port}/health`);
    // dev 模式（AGENT_WEB=vite）自动拉起 dashboard HMR；生产模式走静态 dist
    if (spawnViteDev(config.port)) {
      console.log(`  Dashboard (Vite HMR): http://localhost:5173/dashboard`);
    } else {
      // 配了 token 时把它带进 URL —— 否则用户打开看板只会看到 403，
      // 而 token 是他自己设的、多半已经忘了要往哪儿传
      console.log(`  Dashboard: ${dashboardUrlWithToken(config.port)}`);
    }
    // 缺凭据时把引导印在最后一屏——现在跟员工说话只会拿到固定文案，不会真的调模型
    const guidance = startupGuidance(config.port);
    if (guidance) console.log(guidance);
    // 有凭据就真验一次。不阻塞启动：验不通也要让服务起来，否则用户连看板都打不开去改 key
    if (hasUsableModel()) {
      void verifyCredential().then((r) => {
        console.log(
          r.ok
            ? `[model] 凭据自检通过（${r.ms}ms）`
            : `\n⚠️  [model] 凭据自检失败（${r.ms}ms）：${r.detail}\n   去 ${dashboardUrl(config.port)} → 设置 → 模型与凭据 核对\n`,
        );
      });
    }
  });
  server.on("error", (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(
        `\n启动失败：端口 ${config.port} 已被占用。\n` +
          `  · 换端口：PORT=3001 foreman start\n` +
          `  · 或关掉占用进程：lsof -nP -iTCP:${config.port} -sTCP:LISTEN\n`,
      );
    } else {
      console.error("HTTP 服务启动失败:", err);
    }
    process.exit(1);
  });

  // 启动序列（含顺序约束）统一在 boot/boss-runtime.ts，与交互式 CLI 共用一份
  const runtime = await startBossRuntime();
  if (runtime.startedChannels.length === 0) {
    console.log("[serve] 未配置任何渠道，仅提供 HTTP + 看板");
  }

  // stop() 幂等，用 once 避免第二次信号重入
  const shutdown = () => {
    void runtime.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
