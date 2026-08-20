import { isRuntimeKind, RUNTIME_KINDS, type RuntimeKind } from "../runtime/types.js";

export interface CliArgs {
  /**
   * 子命令：
   * - `cli`：交互式对话 + 看板 + 渠道（默认，也是唯一对外宣传的入口）
   * - `serve`：无 TTY 的守护形态（systemd / nohup / 容器）。Ink 需要 TTY，那些场景只能走它
   * - `setup`：显式重跑配置向导
   */
  command: "serve" | "cli" | "setup";
  /** -p/--print：headless 单次执行的 prompt；undefined=进入交互 REPL */
  print?: string;
  /** --agent：指定 agent 名，默认 default */
  agent: string;
  /** 是否显式指定了 --agent：true=直连该 agent（跳过 boss），false=默认走 boss 对话 */
  direct: boolean;
  /** --remote：直连远端服务（http://host:port），不在本地起内嵌 server */
  remote?: string;
  /** --resume=<sessionId>：直接恢复指定会话 */
  resume?: string;
  /** --task=<taskId>：恢复 workflow 任务档案（追问模式） */
  task?: string;
  /** --continue：恢复上次会话 */
  continue: boolean;
  /**
   * 是否启动渠道（钉钉等）。**默认 true** —— 配了凭据就该连上，不该再记一个开关。
   * `--no-channels` 关掉：同一机器人只允许一个进程持连接，开第二个终端时用它避免抢锁。
   */
  channels: boolean;
  /**
   * --runtime=<vercel|qoder>：本进程用哪个 LLM 执行后端，**全局生效**（非 per-agent）。
   * 不给则沿用环境变量 FOREMAN_RUNTIME，仍没有则 vercel。
   */
  runtime?: RuntimeKind;
  help: boolean;
}

export const HELP_TEXT = `foreman — 一句话交给主管，他分诊派活、验收、汇报

用法:
  foreman                    进入交互式对话（同时起 Web 看板；配了钉钉凭据就一起连上）
  foreman -p "<prompt>"      headless 单次执行，输出结果后退出
  foreman setup              重跑配置向导（模型凭据）
  foreman gate --help        回归门禁操作台（提示词提案的回归证据）
  foreman migrate --help     换设备迁移（导出/导入运行目录：员工、经验库、定时任务、回归基线）

首次使用: 没配模型凭据时会自动弹出配置向导；进对话后输入 /setup 可查配置指引

选项:
  --no-channels        不启动钉钉等渠道。开第二个终端时用它 ——
                       同一机器人只允许一个进程持连接，否则新进程会接管并结束旧进程
  --agent=<name>       直连指定 agent（跳过 boss，默认与 boss 对话）
  --runtime=<name>     LLM 执行后端：vercel（默认）| qoder。全局生效
                       qoder 复用 Qoder 账号 token，需设 QODER_PERSONAL_ACCESS_TOKEN
  --remote=<url>       直连远端服务，如 --remote=http://host:3000
  --continue           恢复上次会话继续对话
  --resume=<sessionId> 恢复指定会话
  --task=<taskId>      恢复 workflow 任务档案（追问模式）
  -h, --help           显示帮助

无 TTY 环境（systemd / nohup / 容器）用 foreman start —— 纯服务形态，不渲染终端界面。
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "cli",
    agent: "default",
    direct: false,
    continue: false,
    // 默认开：渠道配了就连。想关用 --no-channels
    channels: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // start 是 serve 的别名：对外发布时 `foreman start` 比 `serve` 更符合直觉，
    // 而 serve 已经写进现有部署脚本，两个都留着
    if ((a === "serve" || a === "start") && i === 0) args.command = "serve";
    else if (a === "setup" && i === 0) args.command = "setup";
    else if (a === "-p" || a === "--print") args.print = argv[++i] ?? "";
    else if (a.startsWith("--agent=")) {
      args.agent = a.slice("--agent=".length);
      args.direct = true;
    } else if (a.startsWith("--remote=")) args.remote = a.slice("--remote=".length);
    else if (a.startsWith("--resume=")) args.resume = a.slice("--resume=".length);
    else if (a.startsWith("--task=")) args.task = a.slice("--task=".length);
    else if (a === "--continue" || a === "-c") args.continue = true;
    else if (a === "--no-channels") args.channels = false;
    else if (a.startsWith("--runtime=")) {
      const v = a.slice("--runtime=".length);
      // 早失败：runtime 选错了整个进程的行为都不对，不该等跑起来才发现
      if (!isRuntimeKind(v)) {
        throw new Error(`--runtime 取值无效："${v}"。可选：${RUNTIME_KINDS.join(" | ")}`);
      }
      args.runtime = v;
    }
    // --channels / --serve：渠道已改为默认启动，这两个保留为兼容 no-op（老脚本还在用）
    else if (a === "--channels" || a === "--serve") args.channels = true;
    else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}
