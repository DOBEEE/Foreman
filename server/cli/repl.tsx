import React from "react";
import { render } from "ink";
import { config } from "../config/index.js";
import type { CliArgs } from "./args.js";
import { startLocalBackend, type LocalBackend } from "./backend.js";
import { CLI_DEFAULT_CHAT_ID } from "../channels/types.js";
import { mirrorConsoleToFile } from "../core/logger.js";
import {
  bindHost,
  dashboardUrlWithToken,
  hasUsableModel,
  startupGuidance,
} from "../core/onboarding.js";
import { startBossRuntime, type BossRuntimeHandle } from "../boot/boss-runtime.js";
import { spawnViteDev } from "../api/vite-spawn.js";
import { loadLastSession } from "./session.js";
import { runSetupWizard } from "./setup-wizard.js";
import { App, type AgentInfo, type CommandInfo } from "./App.js";

async function fetchCommands(baseUrl: string): Promise<CommandInfo[]> {
  try {
    const res = await fetch(`${baseUrl}/api/commands`);
    const body = (await res.json()) as { commands?: CommandInfo[] };
    return body.commands ?? [];
  } catch {
    return [];
  }
}

async function fetchAgents(baseUrl: string): Promise<AgentInfo[]> {
  try {
    const res = await fetch(`${baseUrl}/api/agents`);
    const body = (await res.json()) as { agents?: AgentInfo[] };
    return body.agents ?? [];
  } catch {
    return [];
  }
}

/** 启动横幅：真实端口、看板地址，以及「端口回退了」「已对局域网开放」这两件必须说的事 */
function printBackendBanner(backend: LocalBackend): void {
  console.log(`[cli] 看板：${dashboardUrlWithToken(backend.port)}`);
  if (backend.fellBack) {
    console.log(
      `[cli] 端口 ${backend.requestedPort} 已被占用（多半是另一个 foreman），本次用 ${backend.port}`,
    );
  }
  if (backend.host === "0.0.0.0") {
    console.log(
      "[cli] ⚠️  看板端口已对局域网开放（DASHBOARD_ACCESS=lan / DASHBOARD_TOKEN）· 该面板可读写模型凭据",
    );
  }
}

export async function startRepl(args: CliArgs): Promise<void> {
  // Ink 需要 TTY。没有的话早点说清楚，而不是抛一个费解的渲染错误
  if (!process.stdout.isTTY) {
    console.error(
      "当前环境没有 TTY，交互式界面渲染不了。\n" +
        "  · 纯服务形态（systemd / nohup / 容器）：foreman start\n" +
        '  · 单次执行：foreman -p "<prompt>"',
    );
    process.exit(1);
  }

  let backend: LocalBackend | undefined;
  let runtime: BossRuntimeHandle | undefined;

  if (!args.remote) {
    // 必须在 createApp 与 Ink render 之前：createApp 会打启动日志（晚了落不下来），
    // 而 Ink 的 patchConsole 会再包一层 console —— 顺序反了 console 输出会绕过 Ink 打乱提示符
    mirrorConsoleToFile();

    // 固定端口才能给出稳定的看板地址；被占（另一个终端）就回退随机端口，不该起不来
    backend = await startLocalBackend({
      port: config.port,
      host: bindHost(),
      fallbackToRandomPort: true,
    });
    printBackendBanner(backend);

    runtime = await startBossRuntime({ channels: args.channels });
    if (runtime.startedChannels.length > 0) {
      console.log(
        `[cli] 渠道已启动：${runtime.startedChannels.join(" / ")} · ` +
          "群里的人与你共享会话与记忆（IDENTITY_MODE=single-user）；多人使用请设 IDENTITY_MODE=off",
      );
    }
  }

  const baseUrl = args.remote ?? backend!.url;

  // dev 模式（AGENT_WEB=vite）拉起 Vite dashboard，proxy 指向真实后端端口
  // CLI 用 Ink 独占 TTY，vite 输出必须落日志，否则会顶乱输入光标
  if (backend) {
    if (spawnViteDev(backend.port, { silent: true })) {
      console.log(`[cli] Dashboard (Vite HMR): http://localhost:5173/dashboard`);
    }
  }

  const last = args.continue ? loadLastSession() : undefined;
  const matched = last && last.agent === args.agent ? last : undefined;
  const [commands, agents] = await Promise.all([
    fetchCommands(baseUrl),
    fetchAgents(baseUrl),
  ]);

  // 缺凭据先把配置这件事做完：不引导的话，用户要先说完一句话、等 runtime 抛错才知道去哪配，
  // 而那条错误看起来像「员工出问题了」。--remote 跳过（凭据在远端那台机器上）。
  if (!args.remote && !hasUsableModel()) {
    await runSetupWizard(backend!.port);
    // 向导可能被跳过；仍不可用就退回原来的横幅，把地址与 /setup 留给用户
    const guidance = startupGuidance(backend!.port);
    if (guidance) console.log(guidance);
  }

  // 退出时打印恢复信息用
  let anchor: { sessionId?: string; taskId?: string } = {};

  const { waitUntilExit, unmount } = render(
    <App
      baseUrl={baseUrl}
      agentName={args.agent}
      mode={args.direct ? "direct" : "boss"}
      chatId={CLI_DEFAULT_CHAT_ID}
      initialResume={args.resume ?? matched?.sessionId}
      initialTaskId={args.task ?? matched?.taskId}
      backendLabel={
        args.remote ??
        `local :${backend!.port}${runtime?.startedChannels.length ? " + 渠道" : ""}`
      }
      commands={commands}
      agents={agents}
      onAnchorChange={(a) => {
        anchor = a;
      }}
    />,
    { exitOnCtrlC: true },
  );

  // 注册在 render 之后：被信号打断时要先 unmount 还原 TTY（raw mode / 光标），
  // 否则终端会留在错乱状态。SIGTERM 最常见的来源是另一个 foreman 接管了钉钉锁。
  const shutdown = (signal: NodeJS.Signals) => {
    unmount();
    console.log(
      `\n[cli] 收到 ${signal}，正在退出…` +
        (signal === "SIGTERM"
          ? "（多半是另一个 foreman 接管了钉钉渠道；想同时开两个终端请用 foreman --no-channels）"
          : ""),
    );
    void runtime?.stop().finally(() => void backend?.close().finally(() => process.exit(0)));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await waitUntilExit();
  await runtime?.stop(); // 幂等，与信号路径重复调也安全
  await backend?.close();

  // 仅直连模式（--agent）走客户端会话锚点；boss 模式的连续性由服务端维护
  if (args.direct && (anchor.sessionId || anchor.taskId)) {
    const agentFlag = args.agent !== "default" ? ` --agent=${args.agent}` : "";
    const remoteFlag = args.remote ? ` --remote=${args.remote}` : "";
    const resumeFlag = anchor.sessionId
      ? ` --resume=${anchor.sessionId}`
      : ` --task=${anchor.taskId}`;
    console.log(
      [
        "",
        `会话已保存${anchor.sessionId ? ` · sessionId: ${anchor.sessionId}` : ""}${anchor.taskId ? ` · taskId: ${anchor.taskId}` : ""}`,
        "恢复方式：",
        `  foreman${agentFlag}${remoteFlag}${resumeFlag}`,
        `  foreman${agentFlag}${remoteFlag} --continue        # 恢复最近一次会话`,
        `  foreman${agentFlag}${remoteFlag} 后输入 /resume     # 从历史列表选择`,
        "",
      ].join("\n"),
    );
  }
  process.exit(0);
}
