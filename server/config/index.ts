import "dotenv/config";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { configDir, parsePathList, serviceRoot } from "./paths.js";
import { isRuntimeKind, RUNTIME_KINDS, type RuntimeKind } from "../runtime/types.js";

/**
 * 配置分三层，优先级 env > server/config/app.json > 内置默认值：
 * - 内置默认值：本文件，保证零配置可跑
 * - server/config/app.json：公共行为参数（端口、模型、轮次、渠道开关、定时任务），进 git
 * - .env：**只放凭据与机器相关路径**（API key、钉钉 secret、本机目录），不进 git
 *
 * agent 专属配置不在这里，见 server/config/agents/<id>.json（agent-profile.ts）。
 */
interface AppFile {
  port?: number;
  publicBaseUrl?: string;
  model?: string;
  routerModel?: string;
  maxTurns?: number;
  maxAutoContinues?: number;
  disabledTools?: string[];
  dashboardAccess?: "lan" | "localhost";
  maxConcurrentRuns?: number;
  memory?: boolean;
  /** 全局默认模型供应商 id（providers.json 里的一项）；未设则用 .env 里的 ANTHROPIC_* 兜底 */
  defaultProviderId?: string;
  /** 主管自身 LLM 调用（对话决策/裁决/验收）的供应商与模型覆盖；不设则走全局默认 */
  boss?: { providerId?: string; model?: string; maxSteps?: number };
  /** Qoder runtime 专属配置。model 取 Qoder 自己的档位/别名（auto / ultimate / …） */
  qoder?: {
    model?: string;
    /**
     * 授权方式。缺省 `qodercli` = 同步本机 qodercli 登录态（无需任何密钥）。
     * `accessToken` / `serviceAccount` 的密钥不落这里，走 secrets.json（见 providers-store）。
     * `envVar` 只在希望「从指定环境变量取」时填，留空则用 secrets.json 里存的值。
     */
    auth?: { mode?: "qodercli" | "accessToken" | "serviceAccount"; envVar?: string };
  };
  paths?: {
    workingDir?: string;
    runtimeDir?: string;
    knowledgeDir?: string;
    pluginsDir?: string;
    codeRoots?: string[];
    /** 其他 coding agent 的全局 skill 目录，仅作后台导入候选源 */
    externalSkillDirs?: string[];
  };
  /**
   * 跨渠道身份归一（见 core/identity.ts）：把同一个人在各渠道的私聊并成一个会话上下文。
   * mode 缺省按入口定（serve=off，CLI=single-user，见 server/index.ts）。
   */
  identity?: {
    mode?: "single-user" | "off";
    principals?: Array<{
      id?: string;
      label?: string;
      bindings?: Array<{ channel?: string; senderId?: string }>;
    }>;
  };
  /**
   * 钉钉渠道配置。一种渠道类型一个实例——新增飞书/企微时在此加同级的 `feishu` / `wecom` 块，
   * 不做「同类型多实例」：员工、知识库、工作台都是服务实例级共享的，接第二个企业请起
   * 第二个服务实例（换 runtimeDir），否则等于跨企业共享团队资产。
   */
  dingtalk?: { ack?: boolean; ackDelayMs?: number; clientId?: string; robotCode?: string };
  assist?: { enabled?: boolean; maxSelfAnswers?: number; maxReassigns?: number; maxReviewRetries?: number };
  retro?: {
    schedule?: boolean;
    hour?: number;
    notifyChat?: string;
    notifyUser?: string;
  };
  optimizer?: {
    schedule?: boolean;
    weekday?: number;
    hour?: number;
    days?: number;
  };
  /** 一层回归评测（采集扫描 + 确定性断言回归） */
  bench?: {
    schedule?: boolean;
    weekday?: number;
    hour?: number;
    days?: number;
  };
  /** 提示词提案的回归门禁：off=不检查，warn=只提示，enforce=无通过证据不许应用 */
  gate?: { mode?: "off" | "warn" | "enforce" };
  tempWorker?: { ttlHours?: number; maxLive?: number };
  taskWorkspace?: { retentionDays?: number };
  logs?: { retentionDays?: number };
  consolidation?: { minCluster?: number; pruneDays?: number };
  compact?: {
    contextWindow?: number;
    atPercent?: number;
    hardAtPercent?: number;
    minWindow?: number;
  };
}

function readAppFile(): AppFile {
  const file = join(configDir, "app.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as AppFile;
  } catch (error) {
    console.warn(`[config] 解析 ${file} 失败，按默认值启动:`, error);
    return {};
  }
}

const app = readAppFile();

/** env 数字（空/非法则忽略） */
function envNum(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** env 布尔："off"/"false"/"0" 为假，其余非空为真 */
function envBool(raw: string | undefined): boolean | undefined {
  if (raw == null || raw === "") return undefined;
  return !["off", "false", "0", "no"].includes(raw.toLowerCase());
}

/** env 逗号分隔清单：未设置 → undefined；设为空串 → 显式清空（[]） */
function csvList(raw: string | undefined): string[] | undefined {
  if (raw == null) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 目录项：env > app.json > 默认值，统一解析为绝对路径 */
function dir(
  envValue: string | undefined,
  fileValue: string | undefined,
  fallback: string,
): string {
  const raw = envValue || fileValue;
  return raw ? resolve(raw) : fallback;
}

/**
 * 用户目录：仓库外的 ~/.foreman（用户资产 + 运行状态）。
 * 与代码仓库解耦——升级/重装代码不影响用户的员工、工具、经验库与会话。
 */
const runtimeDir = dir(
  process.env.RUNTIME_DIR,
  app.paths?.runtimeDir,
  join(homedir(), ".foreman"),
);

/**
 * 用户设置覆盖层：<runtimeDir>/settings.json，与 app.json 同构，不进 git。
 * 优先级 settings > env > app.json > 默认——后台改的设置必须立刻压过一切，否则页面就是骗人的。
 * 注意 runtimeDir 本身不吃这层覆盖（覆盖文件的路径依赖它，会成鸡生蛋），改它仍需重启。
 */
export const SETTINGS_FILE = join(runtimeDir, "settings.json");

/** settings.json 的 mtime（缺失返回 0）：config 的 Proxy 靠它判定是否重建快照 */
export function settingsMtime(): number {
  try {
    return statSync(SETTINGS_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

/** 读取用户设置覆盖层；文件缺失/损坏时按空覆盖处理（回落 env/app.json/默认） */
export function readSettingsOverlay(): AppFile {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as AppFile;
  } catch (error) {
    console.warn(`[config] 解析 ${SETTINGS_FILE} 失败，忽略该覆盖层:`, error);
    return {};
  }
}

/** 取第一个已定义值（层级择优：settings > env > app > 默认） */
function pick<T>(...vals: (T | undefined)[]): T | undefined {
  for (const v of vals) if (v !== undefined) return v;
  return undefined;
}

/**
 * 本机对外可达的 IPv4：只在物理网卡里挑（排除 VPN/虚拟网卡——隧道地址别人访问不到），
 * 物理网卡内优先私网段。都拿不到才回落 localhost。
 */
function lanAddress(): string {
  const VIRTUAL = /^(utun|tun|tap|ppp|awdl|llw|bridge|vmnet|vnic|docker|veth|wg|zt)/i;
  const physical: string[] = [];
  const others: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      (VIRTUAL.test(name) ? others : physical).push(ni.address);
    }
  }
  const isPrivate = (ip: string): boolean =>
    /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return (
    physical.find(isPrivate) ?? physical[0] ?? others.find(isPrivate) ?? others[0] ?? "localhost"
  );
}

/**
 * 解析 LLM 执行后端。来源只有环境变量：启动参数 --runtime 会写进 FOREMAN_RUNTIME
 * （server/index.ts），这样 getRuntime() 在深处读一次即可，不必一路透传 CLI 参数。
 *
 * 刻意不放进 app.json / settings.json：它是「本次进程用哪个后端」的启动期决定，
 * 落盘反而会让同机不同进程互相干扰。
 */
function resolveRuntimeKind(): RuntimeKind {
  const raw = process.env.FOREMAN_RUNTIME?.trim();
  if (!raw) return "vercel";
  if (isRuntimeKind(raw)) return raw;
  console.warn(
    `[config] FOREMAN_RUNTIME 取值无效："${raw}"（可选：${RUNTIME_KINDS.join(" | ")}），回落 vercel`,
  );
  return "vercel";
}

function computeConfig(s: AppFile) {
  return {
  port: envNum(process.env.PORT) ?? app.port ?? 3000,
  /**
   * 对外可达的服务基址（不带尾斜杠）：渠道消息里的任务详情链接用它拼 URL。
   * 未配置则回落本机局域网 IP（同网段的同事/手机能直接点开）；公网场景仍应显式配置。
   */
  publicBaseUrl:
    (s.publicBaseUrl || process.env.PUBLIC_BASE_URL || app.publicBaseUrl || "").replace(/\/+$/, "") ||
    `http://${lanAddress()}:${envNum(process.env.PORT) ?? app.port ?? 3000}`,
  /** 服务自身安装根目录（optimizer 等需要读写服务仓库内文件的 agent 使用） */
  serviceRoot,
  /** 仓库内配置目录 */
  configDir,
  /** 运行时/临时状态根：会话、任务、锁、boss 记忆、员工配置与工作目录 */
  runtimeDir,
  /** 配置驱动员工（HR 招聘产出）的配置目录，运行时私有、不进 git */
  hiredAgentsDir: join(runtimeDir, "agents"),
  /**
   * 已释放临时工的 profile 归档目录。systemPrompt 从不进日志、只存在于 profile 文件里，
   * 而它正是 hr 归纳建岗时最需要的素材，所以删除路径必须先归档到这里（台账存其路径）。
   */
  agentsArchiveDir: join(runtimeDir, "agents-archive"),
  /** 用户自装 plugin（skills/commands）目录，与内置 plugins/ 合并加载，不进 git */
  userPluginsDir: join(runtimeDir, "plugins"),
  /** 用户自装 MCP 声明文件，与内置 server/config/mcp.servers.json 合并（同名覆盖），不进 git */
  userMcpFile: join(runtimeDir, "mcp.servers.json"),
  /** 所有 agent 工作目录的根：<workspacesRoot>/<agentId>[/<分桶>] */
  workspacesRoot: join(runtimeDir, "workspaces"),
  /**
   * LLM 执行后端，全局生效。由启动参数 --runtime 写入 FOREMAN_RUNTIME（见 server/index.ts）。
   * 非法取值告警后回落 vercel——runtime 选错不该让进程直接起不来。
   */
  runtimeKind: resolveRuntimeKind(),
  /**
   * Qoder runtime 的模型配置。**刻意与 `model` 分开**：
   * `model` 是 Anthropic/OpenAI 的具体模型名，而这里取的是 Qoder 自己的档位/别名
   * （`auto` / `ultimate` / `performance` / `qmodel_38max` …，用 `foreman` 看板下拉可选）。
   * 两套标识不通用，混用只会得到「未知模型」。留空 = 用 Qoder 服务端默认（auto）。
   */
  qoder: {
    model: s.qoder?.model || process.env.QODER_MODEL || app.qoder?.model || undefined,
    /**
     * 授权方式。默认 `qodercli`：同步本机 qodercli 登录态，零配置即可用，
     * 也是接这个 runtime 的初衷。另两种给没有本机登录态的场景（CI / 容器 / 服务账号）。
     */
    auth: {
      mode:
        s.qoder?.auth?.mode ||
        (process.env.QODER_AUTH_MODE as "qodercli" | "accessToken" | "serviceAccount" | undefined) ||
        app.qoder?.auth?.mode ||
        "qodercli",
      envVar: s.qoder?.auth?.envVar || app.qoder?.auth?.envVar || undefined,
    },
  },
  /** 不设置则用 SDK 默认模型 */
  model: s.model || process.env.MODEL || app.model || undefined,
  /** 路由器/裁决类轻量调用专用模型；不设置则用 model */
  routerModel: s.routerModel || process.env.ROUTER_MODEL || app.routerModel || undefined,
  /** 全局默认模型供应商 id（providers.json）；未设则用 .env 的 ANTHROPIC_* 兜底 */
  defaultProviderId: s.defaultProviderId || app.defaultProviderId || undefined,
  /** 主管自身 LLM 调用的供应商/模型覆盖 */
  boss: {
    providerId: s.boss?.providerId || app.boss?.providerId || undefined,
    model: s.boss?.model || app.boss?.model || undefined,
    /** agent 模式下单轮最多几步工具循环 */
    maxSteps: pick(s.boss?.maxSteps, envNum(process.env.BOSS_MAX_STEPS), app.boss?.maxSteps) ?? 8,
  },
  /** agent 的默认工作目录（未声明 workspace 的 agent 用它） */
  workingDir: dir(s.paths?.workingDir || process.env.WORKING_DIR, app.paths?.workingDir, process.cwd()),
  maxTurns: pick(s.maxTurns, envNum(process.env.MAX_TURNS), app.maxTurns) ?? 50,
  /**
   * 本环境跑不通的内置工具，统一作为 disallowedTools 下发（免得各岗位白花步数试错）。
   * 默认禁 WebSearch / WebFetch：
   * - WebSearch：模型网关不支持 Anthropic 服务端 web_search 工具，调用直接 400
   * - WebFetch：抓取前的域名安全校验要访问 claude.ai，被网络策略拦掉
   * 联网请走 playwright MCP（打开必应搜索页读正文）。
   * 换了能直连的网关后，把 app.json 的 disabledTools 置为 [] 即可放开。
   */
  disabledTools:
    s.disabledTools ?? csvList(process.env.DISABLED_TOOLS) ?? app.disabledTools ?? ["WebSearch", "WebFetch"],
  /**
   * Dashboard 数据面访问范围：
   * - "lan"（默认）：放行与本机同网段的客户端 —— 群里发出的局域网链接点开即可用
   *   （服务的 /api/agents 等接口本来就对局域网开放，这里保持一致）
   * - "localhost"：只放行本机，最严
   * 跨网段/公网访问一律需要 DASHBOARD_TOKEN。
   */
  /**
   * 看板访问范围。默认 **localhost** —— 看板能配模型凭据、能改岗位提示词，
   * 默认对同网段开放意味着任何人都能拿走 key 或改掉员工行为。
   * 需要局域网访问时显式设 DASHBOARD_ACCESS=lan，跨网段必须配 DASHBOARD_TOKEN。
   */
  dashboardAccess: (process.env.DASHBOARD_ACCESS || app.dashboardAccess || "localhost") as
    | "lan"
    | "localhost",
  /**
   * 单轮步数用满后自动 resume 续跑的次数上限（默认 2 → 总额度约 maxTurns×3）。
   * maxTurns 因此从「硬墙」变成「检查点」：复杂任务自动接着干，绕圈任务仍有天花板；
   * 预算用尽才转 waiting_user 问用户。
   */
  maxAutoContinues: pick(s.maxAutoContinues, envNum(process.env.MAX_AUTO_CONTINUES), app.maxAutoContinues) ?? 2,
  /**
   * boss 自主协调：员工提问先由 boss 用「用户原话 + 派工简报 + 历史任务」试答，
   * 员工判定做不到时先试改派，都不成才转人。
   *
   * 上限存在的理由：代答与改派都是 boss 替用户做主，必须有天花板——
   * 超过上限一律转人，避免它自作主张一路跑偏而用户毫不知情。
   */
  assist: {
    enabled: pick(s.assist?.enabled, envBool(process.env.BOSS_ASSIST), app.assist?.enabled) ?? true,
    /** 单个任务里 boss 最多代答几次员工提问 */
    maxSelfAnswers: pick(s.assist?.maxSelfAnswers, envNum(process.env.BOSS_MAX_SELF_ANSWERS), app.assist?.maxSelfAnswers) ?? 2,
    /** 单个任务最多改派几次（防 A→B→C 无限转手） */
    maxReassigns: pick(s.assist?.maxReassigns, envNum(process.env.BOSS_MAX_REASSIGNS), app.assist?.maxReassigns) ?? 1,
    /** 验收不通过后最多追问员工几轮（超过则判失败并告知用户） */
    maxReviewRetries: pick(s.assist?.maxReviewRetries, envNum(process.env.BOSS_MAX_REVIEW_RETRIES), app.assist?.maxReviewRetries) ?? 2,
  },
  /** 全局并发上限：整个实例同时执行的 agent run 数（跨所有渠道/会话） */
  maxConcurrentRuns:
    pick(s.maxConcurrentRuns, envNum(process.env.MAX_CONCURRENT_RUNS), app.maxConcurrentRuns) ?? 8,
  /**
   * 是否放行 SDK 自带的记忆能力（~/.claude/projects/<cwd>/memory/）。
   * 记忆需要唯一主人：本地 CLI（单用户）默认 on；serve 多租户默认 off。
   * 入口 index.ts 按部署形态设置 MEMORY 默认值。
   */
  memoryEnabled: pick(s.memory, envBool(process.env.MEMORY), app.memory) ?? false,
  /** 答疑知识库目录（只读挂入答疑 agent） */
  knowledgeDir: dir(
    s.paths?.knowledgeDir || process.env.KNOWLEDGE_DIR,
    app.paths?.knowledgeDir,
    join(serviceRoot, "knowledge"),
  ),
  /** 业务 playbook plugin 根目录（标准 Claude Code plugin：commands/ + skills/） */
  pluginsDir: dir(
    s.paths?.pluginsDir || process.env.PLUGINS_DIR,
    app.paths?.pluginsDir,
    join(serviceRoot, "plugins"),
  ),
  /** 答疑可检索的业务代码仓库根（勿指向本服务目录） */
  codeRoots: s.paths?.codeRoots
    ? s.paths.codeRoots.map((p) => resolve(p))
    : process.env.ASSISTANT_CODE_ROOTS
      ? parsePathList(process.env.ASSISTANT_CODE_ROOTS)
      : (app.paths?.codeRoots ?? []).map((p) => resolve(p)),
  /**
   * 其他 coding agent（Claude Code / Qoder …）的全局 skill 目录。
   *
   * **只作为后台「导入」的候选来源，不参与运行时扫描**（`discoverAllSkills` 不读它）。
   * 原因：这些目录动辄几十个 skill（实测 24 + 26 个，且多是别的产品的流水线专用），
   * 若纳入运行时，它们的 name+description 会全进每个 agent 的 L1 清单，
   * 白加数千 token 噪音，还会淹掉真正相关的那几个。要用哪个就显式导入哪个。
   */
  externalSkillDirs:
    s.paths?.externalSkillDirs?.map((p) => resolve(p)) ??
    (process.env.EXTERNAL_SKILL_DIRS
      ? parsePathList(process.env.EXTERNAL_SKILL_DIRS)
      : (app.paths?.externalSkillDirs ?? [
          join(homedir(), ".claude", "skills"),
          join(homedir(), ".qoder", "skills"),
        ]).map((p) => resolve(p))),

  /**
   * 跨渠道身份归一。mode 留空字符串表示「没显式配」——由 core/identity.ts 回落
   * IDENTITY_MODE（入口在 server/index.ts 按 serve/CLI 定默认值）。
   */
  identity: {
    mode: s.identity?.mode ?? app.identity?.mode ?? "",
    principals: s.identity?.principals ?? app.identity?.principals ?? [],
  },

  /** 钉钉渠道行为（凭据 clientSecret 走 credentials-store，clientId/robotCode 可在此配，均支持 .env 兜底） */
  dingtalk: {
    /** 收到消息后 boss 迟迟未回时，先发一句「收到」兜住等待感 */
    ack: pick(s.dingtalk?.ack, envBool(process.env.DINGTALK_ACK), app.dingtalk?.ack) ?? true,
    /** ack 阈值：replied 在 boss 调 reply 的瞬间即置位（不含网络耗时），故 350ms 足够区分快慢路径 */
    ackDelayMs:
      pick(s.dingtalk?.ackDelayMs, envNum(process.env.DINGTALK_ACK_DELAY_MS), app.dingtalk?.ackDelayMs) ?? 350,
    /** 企业内部机器人 AppKey（= clientId） */
    clientId: s.dingtalk?.clientId || process.env.DINGTALK_CLIENT_ID || app.dingtalk?.clientId || "",
    /** 主动推送用 robotCode；单独创建的机器人有独立值，留空则回落 clientId（见 push.ts） */
    robotCode: s.dingtalk?.robotCode || process.env.DINGTALK_ROBOT_CODE || app.dingtalk?.robotCode || "",
  },

  /** 每日定时复盘 */
  retro: {
    schedule: pick(s.retro?.schedule, envBool(process.env.RETRO_SCHEDULE), app.retro?.schedule) ?? true,
    hour: pick(s.retro?.hour, envNum(process.env.RETRO_HOUR), app.retro?.hour) ?? 21,
    /** 推送通道，按序取第一个可用：群 → 单聊 → webhook → 仅日志 */
    notifyChat: s.retro?.notifyChat || process.env.RETRO_NOTIFY_CHAT || app.retro?.notifyChat || "",
    notifyUser: s.retro?.notifyUser || process.env.RETRO_NOTIFY_USER || app.retro?.notifyUser || "",

  },
  /**
   * 定时提示词优化：**每周**一次（不跟复盘同频）。
   * 提示词是行为契约、不宜频繁改；每周的样本量才够支撑高置信度提案。
   * 时刻默认与复盘同点，靠 schedule 的 dependsOn 排在复盘**之后**——复盘的当天记录里
   * 有明确写给优化师的归因线索，等它落盘再分析，「复盘结束、优化跟进」是一次连贯的夜间
   * 流程；频率仍是每周，只有周一那晚会跟。
   * 通知通道复用 retro 的配置。
   */
  optimizer: {
    schedule: pick(s.optimizer?.schedule, envBool(process.env.OPTIMIZER_SCHEDULE), app.optimizer?.schedule) ?? true,
    /** 0=周日 … 1=周一 */
    weekday: pick(s.optimizer?.weekday, envNum(process.env.OPTIMIZER_WEEKDAY), app.optimizer?.weekday) ?? 1,
    hour: pick(s.optimizer?.hour, envNum(process.env.OPTIMIZER_HOUR), app.optimizer?.hour) ?? 21,
    /** 回看天数：覆盖上一周 */
    days: pick(s.optimizer?.days, envNum(process.env.OPTIMIZER_DAYS), app.optimizer?.days) ?? 7,
  },
  /**
   * 一层回归评测（零 LLM 确定性断言）。
   *
   * 刻意排在优化师**之前**：优化师吃的是回归报告里的 finding，报告没先产出来它就只能
   * 退回去翻 trace，那正是这次要改掉的东西。
   *
   * 也刻意不给每个岗位排期——只有攒下了 case 的岗位才会被跑（见 bench/cycle.ts）。
   * 为一个没出过问题的岗位跑评测，除了烧钱什么都得不到。
   */
  bench: {
    schedule: pick(s.bench?.schedule, envBool(process.env.BENCH_SCHEDULE), app.bench?.schedule) ?? true,
    /** 与优化师同一天，早一小时，留出跑完的余量 */
    weekday: pick(s.bench?.weekday, envNum(process.env.BENCH_WEEKDAY), app.bench?.weekday) ?? 1,
    hour: pick(s.bench?.hour, envNum(process.env.BENCH_HOUR), app.bench?.hour) ?? 20,
    /** 采集扫描的回看天数 */
    days: pick(s.bench?.days, envNum(process.env.BENCH_DAYS), app.bench?.days) ?? 7,
  },
  /**
   * 提示词提案的回归门禁。默认 off —— 它依赖 agent-bench 的基线与候选报告，
   * 默认开 enforce 会让还没接评测的部署直接无法应用任何提案。
   * 接好评测后按 off → warn（观察判定是否合理）→ enforce 逐级收紧。
   */
  gate: {
    mode:
      (pick(s.gate?.mode, process.env.GATE_MODE, app.gate?.mode) as
        | "off"
        | "warn"
        | "enforce"
        | undefined) ?? "off",
  },
  /**
   * 临时工：用完即释放，攒不起来的东西不会泛滥（比任何配额都硬）。
   * ttl 覆盖「交付后用户追一句『再改一下』」的常见窗口，超期重新招即可（归档里有原提示词）。
   */
  tempWorker: {
    ttlHours: pick(s.tempWorker?.ttlHours, envNum(process.env.TEMP_TTL_HOURS), app.tempWorker?.ttlHours) ?? 2,
    /** 同时在岗上限：纯粹防失控循环的保险丝，不是主防泛滥机制 */
    maxLive: pick(s.tempWorker?.maxLive, envNum(process.env.TEMP_MAX_LIVE), app.tempWorker?.maxLive) ?? 3,
  },
  /**
   * per-task 工作目录的保留期。开了并发槽的岗位每个任务一份工作目录（对 coder 就是
   * 一份仓库 clone），不清会静默涨磁盘。
   *
   * **不能任务终态即删**：用户还要回去看 diff、验收员还要打开文件核对产出。
   * 3 天覆盖「交付后隔天再追一句」的常见窗口。
   */
  taskWorkspace: {
    retentionDays:
      pick(
        s.taskWorkspace?.retentionDays,
        envNum(process.env.TASK_WORKSPACE_RETENTION_DAYS),
        app.taskWorkspace?.retentionDays,
      ) ?? 3,
  },
  /**
   * 日志保留天数（按天分片的 logs/<kind>-YYYY-MM-DD.jsonl）。
   *
   * 缺省 **0 = 不清理**：删日志不可逆，而「多久算过期」取决于你还想不想回看那段 trace，
   * 这只能由人定。任务的结论已有长期档案兜底（core/task-archive.ts），日志留的是过程细节，
   * 想省磁盘就设成 30 / 60。
   */
  logs: {
    retentionDays:
      pick(
        s.logs?.retentionDays,
        envNum(process.env.LOGS_RETENTION_DAYS),
        app.logs?.retentionDays,
      ) ?? 0,
  },
  /**
   * 临时工归纳成正式岗位：台账是**持久累加器**，不是滚动窗口——
   * 同类需求可能相隔两周才出现第二次，按时间窗永远凑不满一簇。
   */
  consolidation: {
    /** 同一能力域出现几次才值得设岗（够了才叫 hr，空闲天数零成本） */
    minCluster: pick(s.consolidation?.minCluster, envNum(process.env.CONSOLIDATION_MIN_CLUSTER), app.consolidation?.minCluster) ?? 3,
    /** 兜底剪枝：pending 超过这个天数且始终没凑够阈值的记录清掉（真一次性需求不该永久占位） */
    pruneDays: pick(s.consolidation?.pruneDays, envNum(process.env.CONSOLIDATION_PRUNE_DAYS), app.consolidation?.pruneDays) ?? 90,
  },
  /**
   * 上下文压缩（由 session-store.compactIfNeeded 实现，不是 SDK 内置）。
   * 两级阈值是为了不和 prompt cache 打架——压缩会改写上下文前缀，而 cache 按字节前缀匹配，
   * 一压下一次就必然全量重灌（写入 1.25x/2x，读取只要 0.1x）：
   * - atPercent（软）：到这里**且缓存已过 TTL**才压。缓存反正凉了，此时压缩不额外花钱
   * - hardAtPercent（硬）：无条件压。撞窗口是硬失败，优先级高于省钱；余量留给单次 run 内的增长
   * minWindow 只服务于已废弃的 Claude SDK settings 通道，Vercel runtime 不读它。
   */
  compact: {
    /** 当前模型的上下文窗口（token）；可按岗位用 profile.contextWindow 覆盖 */
    contextWindow: pick(s.compact?.contextWindow, envNum(process.env.CONTEXT_WINDOW), app.compact?.contextWindow) ?? 200_000,
    /** 软阈值：到窗口的百分之多少 + 缓存已冷 才压 */
    atPercent: pick(s.compact?.atPercent, envNum(process.env.COMPACT_AT_PERCENT), app.compact?.atPercent) ?? 0.6,
    /** 硬阈值：到这里无条件压，不看缓存 */
    hardAtPercent: pick(s.compact?.hardAtPercent, envNum(process.env.COMPACT_HARD_AT_PERCENT), app.compact?.hardAtPercent) ?? 0.9,
    /** 窗口不小于这个值才主动压缩（小窗口交给 SDK 默认行为） */
    minWindow: pick(s.compact?.minWindow, envNum(process.env.COMPACT_MIN_WINDOW), app.compact?.minWindow) ?? 1_000_000,
  },
  };
}

export type AppConfig = ReturnType<typeof computeConfig>;

/**
 * config 热更：settings.json 变了就重建快照，全仓 `config.xxx` 消费方零改动。
 * 首次求值在模块加载时；此后每次读属性都比对 mtime，命中缓存则零开销。
 */
let _snapshot = computeConfig(readSettingsOverlay());
let _snapshotMtime = settingsMtime();
function currentConfig(): AppConfig {
  const m = settingsMtime();
  if (m !== _snapshotMtime) {
    _snapshot = computeConfig(readSettingsOverlay());
    _snapshotMtime = m;
  }
  return _snapshot;
}

export const config = new Proxy({} as AppConfig, {
  get: (_t, prop) => currentConfig()[prop as keyof AppConfig],
  has: (_t, prop) => prop in currentConfig(),
  ownKeys: () => Reflect.ownKeys(currentConfig()),
  getOwnPropertyDescriptor: (_t, prop) =>
    Object.getOwnPropertyDescriptor(currentConfig(), prop),
});


export { serviceRoot, configDir, builtinAgentsDir, presetsDir, logDir } from "./paths.js";
