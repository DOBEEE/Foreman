#!/usr/bin/env node
import { HELP_TEXT, parseArgs } from "./cli/args.js";
import { installCrashGuard } from "./core/crash-guard.js";

// 必须最先装载：外部 MCP server / 上游网关的一次超时不该杀掉常驻主管进程。
// 装载点之后发生的错误才拦得住，所以放在所有业务逻辑之前。
installCrashGuard();

const rawArgv = process.argv.slice(2);

// gate / bench / migrate 走位置参数（子动作 + 提案号/caseId/文件路径），与 parseArgs 的 --flag 风格不兼容，先拦掉
if (rawArgv[0] === "gate") {
  const { runGateCommand } = await import("./cli/gate.js");
  await runGateCommand(rawArgv.slice(1));
  process.exit(process.exitCode ?? 0);
}

if (rawArgv[0] === "bench") {
  const { runBenchCommand } = await import("./cli/bench.js");
  await runBenchCommand(rawArgv.slice(1));
  process.exit(process.exitCode ?? 0);
}

// 必须排在 seedUserDir / cleanup* 之前：import 正要把整个运行目录换掉，
// 这时候播种预置或清理过期文件都是往一个即将被替换（或刚被替换）的目录里乱写。
if (rawArgv[0] === "migrate") {
  const { runMigrateCommand } = await import("./cli/migrate.js");
  await runMigrateCommand(rawArgv.slice(1));
  process.exit(process.exitCode ?? 0);
}

const args = parseArgs(rawArgv);

if (args.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

// 记忆策略默认值按入口定（机制共享，仅默认值不同）：
// serve 多租户 = off（跨用户泄漏面）；本地 CLI 单用户 = on。显式设置 MEMORY 环境变量可覆盖。
process.env.MEMORY ??= args.command === "serve" ? "off" : "on";

// 跨渠道身份归一同理：把 CLI 绑到某个 principal，等于「谁能碰到这台机器的 shell，
// 谁就拿到那个人的全部会话与任务」。自托管单用户是想要的，serve 多租户绝不行。
//
// ⚠️ 交互式 `foreman` 现在默认也会启动渠道（配了凭据的话），于是 single-user 的影响面变大了：
// 任何能给钉钉机器人发消息的人（含机器人所在群的全部成员）都会落到本机操作者这个 principal 上，
// 共享会话与任务，且 MEMORY=on 时他们消息里的事实会写进操作者的记忆。
// 多人共用一个机器人请显式设 IDENTITY_MODE=off（并考虑 MEMORY=off）。
process.env.IDENTITY_MODE ??= args.command === "serve" ? "off" : "single-user";

// runtime 选择：显式 --runtime 覆盖环境变量；两者都没有则由 config 兜底 vercel。
// 用 env 而不是一路透传参数：getRuntime() 在 core/runner.ts 深处被调用，离 CLI 参数很远。
// 与上面 MEMORY / IDENTITY_MODE 同一套「启动时设一次、深处读」的接线方式。
if (args.runtime) process.env.FOREMAN_RUNTIME = args.runtime;

// 出厂预置播种：首次启动把 presets/ 复制进用户目录（~/.foreman），之后归用户所有
const { seedUserDir } = await import("./config/seed.js");
seedUserDir();

// 过期笔记清理（笔记是可丢弃原料；复盘结束也会清一次，这里兜住「长期没跑复盘」的情况）
const { cleanupNotes } = await import("./core/notes.js");
cleanupNotes();

// 工作台过期清理。保留期比笔记长得多（60 天 vs 14 天）——它是「这个群里做过什么」的索引，
// 不是可丢弃原料。只在启动时清：按行重写文件的操作不该与任务收尾的 append 并发。
const { cleanupWorkbench } = await import("./core/workbench.js");
cleanupWorkbench();

// 日志按配置清理（logs.retentionDays 缺省 0 = 不清理，函数内部自己判）。
// 任务的结论有长期档案兜底（core/task-archive.ts），logs/ 留的是过程细节。
const { cleanupLogs } = await import("./core/logger.js");
cleanupLogs();

// qoder runtime：校验配置的模型档位是否真在可用列表里。
// 只告警不阻断（详见 warnUnknownQoderModels）；不 await，避免为一次网络往返拖慢启动。
if (process.env.FOREMAN_RUNTIME === "qoder") {
  void (async () => {
    const { config } = await import("./config/index.js");
    const { listAgents, getAgent } = await import("./agents/registry.js");
    const { warnUnknownQoderModels } = await import("./runtime/qoder-models.js");
    await warnUnknownQoderModels([
      { where: "全局 qoder.model", model: config.qoder.model },
      // listAgents() 只给精简形状，qoderModel 在 profile 上，需按名回取
      ...listAgents().map(({ name }) => ({
        where: `岗位 ${name} 的 qoderModel`,
        model: getAgent(name)?.profile.qoderModel,
      })),
    ]);
  })().catch(() => {});
}

if (args.command === "serve") {
  const { startServe } = await import("./api/serve.js");
  await startServe();
} else if (args.command === "setup") {
  // 显式重跑配置向导。先起内嵌 backend 只为拿到真实端口（看板地址要指对），
  // 不起渠道也不起调度 —— 配凭据这件事不需要它们。
  const { startLocalBackend } = await import("./cli/backend.js");
  const { runSetupWizard } = await import("./cli/setup-wizard.js");
  const backend = await startLocalBackend();
  const ok = await runSetupWizard(backend.port);
  await backend.close();
  process.exit(ok ? 0 : 1);
} else if (args.print !== undefined) {
  const { runHeadless } = await import("./cli/headless.js");
  await runHeadless(args);
} else {
  const { startRepl } = await import("./cli/repl.js");
  await startRepl(args);
}
