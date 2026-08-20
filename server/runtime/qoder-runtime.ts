/**
 * QoderRuntime：把 Qoder CLI SDK（`query()`）适配成 AgentRuntime。
 *
 * 存在意义：复用 Qoder 账号的 token（`QODER_PERSONAL_ACCESS_TOKEN`），
 * 不必再单独配 ANTHROPIC/OPENAI 凭据。由启动参数 `--runtime=qoder` 全局选中。
 *
 * ## 本批范围（骨架）
 * 内置工具用 Qoder 自带的那套（`allowedTools` 放行名单即可，无需我们再实现一份
 * Read/Write/Bash）。协议工具（ask_user / report_task_done / submit_step / submit_plan …）
 * 已用 `createSdkMcpServer` 套壳接入（见 qoder-protocol-tools.ts），事件翻译侧会把
 * `mcp__<server>__` 前缀剥回裸名——否则 boss 的 `isAskTool`、lead 的 `submit_plan` 监听全都匹配不上。
 *
 * ## 为什么事件翻译单独抽成纯函数
 * `translateMessage` 不碰网络、不依赖 SDK 运行时，于是「Qoder 消息 → AgentEvent」这层
 * 可以用伪造消息序列做零-LLM 断言（见 __fixtures__/check-qoder-translate.ts）。
 * 这一层出错的表现是「任务看起来在跑但 boss 收不到任何东西」，靠真模型极难复现。
 */

import {
  accessToken,
  accessTokenFromEnv,
  qodercliAuth,
  query,
  serviceAccount,
  serviceAccountFromEnv,
} from "@qoder-ai/qoder-agent-sdk";
import type { AuthOptions } from "@qoder-ai/qoder-agent-sdk";
import type { SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import type {
  AgentRuntime,
  RuntimeCompleteInput,
  RuntimeCompleteResult,
  RuntimeEvent,
  RuntimeRunInput,
} from "./types.js";
import { isRetryableError } from "./transient.js";
import type { ToolGuard } from "./hooks.js";
import { config } from "../config/index.js";
import { getProviderSecret } from "../config/providers-store.js";
import {
  buildQoderProtocolServer,
  PROTOCOL_SERVER,
} from "./qoder-protocol-tools.js";
import { ASK_USER_TOOL } from "../tools/ask-user.js";
import { REPORT_DONE_TOOL } from "../tools/task-report.js";
import { SUBMIT_STEP_TOOL } from "../tools/step-report.js";
import { getQoderSessionStore } from "./qoder-session-store.js";

/**
 * 终止信号工具（裸名）：与 Vercel 侧 `stopWhen: [hasToolCall(...)]` 保持同一组。
 * 复用同样的常量而不是写字面量，避免两个 runtime 的收口条件漂移。
 */
const TERMINAL_TOOLS = new Set([ASK_USER_TOOL, REPORT_DONE_TOOL, SUBMIT_STEP_TOOL]);

/** PAT 的缺省环境变量名（与 SDK 的 DEFAULT_ACCESS_TOKEN_ENV_VAR 对齐） */
const PAT_ENV_VAR = "QODER_PERSONAL_ACCESS_TOKEN";
/** 服务账号密钥的缺省环境变量名 */
const SA_ENV_VAR = "QODER_SERVICE_ACCOUNT_KEY";
/** secrets.json 里存 Qoder 密钥用的键（与供应商密钥同一份文件，权限 0o600） */
export const QODER_SECRET_KEY = {
  accessToken: "qoder:accessToken",
  serviceAccount: "qoder:serviceAccount",
} as const;

/**
 * 解析授权方式。**默认同步本机 qodercli 登录态**（`qodercliAuth()`）——
 * SDK 注释原文 "Reuse the local qodercli login state (read-only)"，零配置即可用，
 * 也是接这个 runtime 的初衷。
 *
 * 另两种给没有本机登录态的场景（CI / 容器 / 服务账号），由看板配置选择：
 * - `accessToken`：个人访问令牌。填了 envVar 就从该环境变量读，否则用 secrets.json 里存的值；
 * - `serviceAccount`：服务账号密钥，同上。
 *
 * 密钥缺失时**回落本机登录态并告警**，而不是抛错：让「已选模式但还没填密钥」这个中间态
 * 仍能跑（本机有登录态的话），且原因写进日志，不至于只看到一句鉴权失败。
 */
export function resolveQoderAuth(env?: Record<string, string>): AuthOptions {
  const mode = config.qoder.auth.mode;
  const readEnv = (name: string): string | undefined =>
    (env?.[name] ?? process.env[name])?.trim() || undefined;

  if (mode === "accessToken") {
    const envVar = config.qoder.auth.envVar?.trim();
    if (envVar) {
      if (readEnv(envVar)) return accessTokenFromEnv(envVar);
      console.warn(`[qoder] 授权方式 accessToken 指定了环境变量 ${envVar}，但它为空 → 回落本机登录态`);
      return qodercliAuth();
    }
    const stored = getProviderSecret(QODER_SECRET_KEY.accessToken)?.trim();
    if (stored) return accessToken(stored);
    // 兼容：没在看板配，但设了缺省环境变量
    if (readEnv(PAT_ENV_VAR)) return accessTokenFromEnv(PAT_ENV_VAR);
    console.warn("[qoder] 授权方式 accessToken 但未配置令牌 → 回落本机登录态");
    return qodercliAuth();
  }

  if (mode === "serviceAccount") {
    const stored = getProviderSecret(QODER_SECRET_KEY.serviceAccount)?.trim();
    if (stored) return serviceAccount({ serviceAccountKey: stored });
    const envVar = config.qoder.auth.envVar?.trim() || SA_ENV_VAR;
    if (readEnv(envVar)) return serviceAccountFromEnv(envVar);
    console.warn("[qoder] 授权方式 serviceAccount 但未配置密钥 → 回落本机登录态");
    return qodercliAuth();
  }

  return qodercliAuth();
}

/** Qoder 内置工具的缺省放行集：与 Vercel 侧 builtinAllow 的语义对齐 */
const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

/**
 * 子代理类工具：**默认必须排除**。
 *
 * 它们是权限绕过面——子代理自己有一套工具集，父级的 `tools` 白名单与 `canUseTool`
 * 未必覆盖到它内部的调用。实测过一次真实绕过：只 `disallowedTools:['Bash']` 时，
 * 模型改用 `Agent` 去做同一件事并成功。
 *
 * 所以只有岗位在 profile.tools 里**显式声明**才给（那是有意授权），
 * 缺省集合里绝不含它们。
 */
const SUBAGENT_TOOLS = ["Agent", "Task"];

/**
 * 解析交给 Qoder 的**真**工具白名单（`options.tools` → CLI `--tools`）。
 *
 * 关键：`builtinAllow` 为空时**也要传**缺省集，不能不传。不传等于沿用 CLI 默认工具集，
 * 而那里含 `Agent` 之类的子代理工具 —— 等于自己把绕过面打开。
 * 纯函数，便于夹具断言（见 __fixtures__/check-qoder-runtime.ts）。
 */
export function resolveQoderTools(builtinAllow?: string[]): string[] {
  if (!builtinAllow) return [...DEFAULT_ALLOWED_TOOLS];
  // 显式声明的子代理工具予以保留（岗位有意授权），未声明的一律不会凭空出现
  return [...builtinAllow];
}

/** 白名单里是否含子代理工具（供审计告警用） */
export function hasSubagentTool(tools: string[]): boolean {
  return tools.some((t) => SUBAGENT_TOOLS.includes(t));
}

/**
 * `complete()` 用的门禁：一律拒绝。
 * 单轮直答按定义不该动任何工具，真出现工具调用属异常，拒掉比放行安全。
 */
const denyAllTools = async (
  toolName: string,
): Promise<{ behavior: "deny"; message: string }> => ({
  behavior: "deny",
  message: `单轮直答不允许调用工具（${stripMcpPrefix(toolName)}）`,
});

/**
 * 刻意**不透传** `input.model`。
 *
 * 本仓的 model 是 Anthropic/OpenAI 的具体模型名（profile.model / providers.json），
 * 而 Qoder 的 `options.model` 取的是它自己的语义档位（SDK 注释里的例子是 `'performance'`）。
 * 把前者塞进后者只会拿到「未知模型」，不如留空让 Qoder 用账号默认档位。
 * 将来要支持按档位选择，应在 profile 上另加一个 qoder 专属字段，而不是复用 model。
 */

/**
 * 把 Qoder 的工具全名还原成裸名：`mcp__foreman__ask_user` → `ask_user`。
 *
 * **这一步不能省**。Qoder 里 in-process MCP 工具对模型显示为 `mcp__<server>__<tool>`，
 * 而全仓消费方一律按裸名匹配：`isAskTool()`（boss.ts 判提问）、
 * `e.data.name === "submit_plan"`（lead.agent.ts 捕获编队计划）、`REPORT_DONE_TOOL`（交卷）。
 * 不剥前缀的表现是「员工明明调了工具，但主管什么都没收到」——任务卡死且无报错。
 *
 * 只剥我们自己注册的那台 server（PROTOCOL_SERVER）：外部 MCP 工具的前缀是它们的身份，
 * 剥掉会让审计与授权范围失去含义。
 */
export function stripMcpPrefix(name: string): string {
  const prefix = `mcp__${PROTOCOL_SERVER}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * 把一条 Qoder SDK 消息翻译成零或多个 RuntimeEvent。
 *
 * 纯函数：同样的输入必得同样的输出，不读环境、不发请求。
 */
export function translateMessage(msg: SDKMessage): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const m = msg as unknown as Record<string, unknown>;

  switch (m.type) {
    case "system": {
      // system/init 是拿 session_id 的地方。必须转成 session 事件：
      // boss 的 runWorker 靠它落盘 sessionId，否则用户回答后无法 resume 续跑。
      if (m.subtype === "init" && typeof m.session_id === "string") {
        out.push({ event: "session", data: { sessionId: m.session_id } });
      }
      return out;
    }

    case "assistant": {
      const message = m.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const raw of blocks) {
        const b = raw as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          out.push({ event: "text", data: { text: b.text } });
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          out.push({ event: "thinking", data: { text: b.thinking } });
        } else if (b.type === "tool_use") {
          out.push({
            event: "tool_call",
            data: {
              id: String(b.id ?? ""),
              // 还原裸名，让 boss/lead 的既有匹配继续生效
              name: stripMcpPrefix(String(b.name ?? "")),
              input: b.input,
            },
          });
        }
      }
      return out;
    }

    case "user": {
      // 工具结果以 user 消息回灌（Anthropic 风格的 tool_result 块）
      const message = m.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const raw of blocks) {
        const b = raw as Record<string, unknown>;
        if (b.type !== "tool_result") continue;
        out.push({
          event: "tool_result",
          data: {
            toolUseId: String(b.tool_use_id ?? ""),
            content: b.content,
            ...(b.is_error === true ? { isError: true } : {}),
          },
        });
      }
      return out;
    }

    case "result": {
      const isError = m.is_error === true || m.subtype !== "success";
      // 失败时把原因拼出来：SDKResultError 用 errors[]，成功态才有 result 文本
      const errors = Array.isArray(m.errors) ? m.errors.filter((e) => typeof e === "string") : [];
      const text =
        typeof m.result === "string" && m.result
          ? m.result
          : errors.length
            ? errors.join("; ")
            : String(m.subtype ?? "unknown");
      out.push({
        event: "result",
        data: {
          subtype: String(m.subtype ?? (isError ? "error" : "success")),
          isError,
          result: text,
          ...(typeof m.session_id === "string" ? { sessionId: m.session_id } : {}),
          ...(typeof m.num_turns === "number" ? { numTurns: m.num_turns } : {}),
          ...(typeof m.duration_ms === "number" ? { durationMs: m.duration_ms } : {}),
          ...(m.usage ? { usage: m.usage } : {}),
          // 让上层的自动重试（boss 主干 / 编队 runDelegate）对 qoder 同样生效
          ...(isError
            ? { errorSource: "model_gateway" as const, retryable: isRetryableError(text) }
            : {}),
        },
      });
      return out;
    }

    default:
      return out;
  }
}

/**
 * 把 AbortSignal 桥成 SDK 要的 AbortController。
 *
 * 接口给的是 signal（只读端），而 Qoder 的 Options 只收 controller。造一个新的
 * controller 并把上游 signal 的 abort 转发进去，这样业务层的打断（用户 /cancel、
 * 编队 abort）仍能真正掐断 Qoder 的这一轮。
 */
function toController(signal?: AbortSignal): AbortController | undefined {
  if (!signal) return undefined;
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

/**
 * Qoder worker 子进程崩溃的识别。
 *
 * SDK 在 CLI worker 非零退出时抛 `Qoder worker runtime exited with code N`。
 * 42 = 无效 session（另有 looksLikeInvalidSession + resume 专用恢复路径）；
 * 其余码是通用崩溃/被杀，退出码本身不带原因，真正的线索在 worker 的 stderr。
 */
const WORKER_EXIT_RE = /worker runtime exited with code (\d+)/i;
export function workerExitCode(text: string): number | undefined {
  const m = WORKER_EXIT_RE.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * worker 崩溃是否值得重试。
 *
 * 非 42 的非零退出与 `terminated` 属同一类「长步骤中途暴毙」（长连接被网关 idle
 * 超时切断、子进程被杀 / OOM）——resume 续跑往往就过。42 不在此列：它是确定性的
 * 无效 session，靠丢弃 resume 重开而非原样重试。
 */
export function isRetryableWorkerCrash(text: string): boolean {
  const code = workerExitCode(text);
  return code !== undefined && code !== 42;
}

/** 抛出的异常统一转成 result 事件：上层只认 result.isError，不接异常 */
function errorResult(error: unknown): RuntimeEvent {
  const message = error instanceof Error ? error.message : String(error);
  return {
    event: "result",
    data: {
      subtype: "error",
      isError: true,
      result: message,
      errorSource: "runtime",
      retryable: isRetryableError(message) || isRetryableWorkerCrash(message),
    },
  };
}

/**
 * 把本仓的 ToolGuard 链接成 Qoder 的 `canUseTool` 回调。
 *
 * 两边形状几乎一致（`(toolName, input) → allow/deny`），所以门禁逻辑**零重写**：
 * `readRoots` / 经验库范围 / 笔记范围 / 主干保护 / MCP 授权那几条 guard
 * （`core/audit.ts`）在两个 runtime 下是同一份实现。
 *
 * 实测要点（用「文件是否真被写」做地面真相验证过，不能靠模型自述）：
 * - canUseTool **只对需要审批的操作触发**（写文件、越界读等）。纯 stdout 的 `echo`
 *   不会触发——这不是缺陷：那类操作本身没有越界面。
 * - `allowedTools` **不会**抑制回调（既在免审批清单里、回调照样问）。
 * - deny 之后操作确实没发生（文件没被创建 / 文件内容没回给模型）。
 *
 * 工具名要先剥前缀再送进 guard：guard 按裸名匹配（`Bash` / `Write` / `Read`），
 * 而 Qoder 传进来的协议工具是 `mcp__foreman__xxx`。
 */
export function buildCanUseTool(guards: ToolGuard[]) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> => {
    const bare = stripMcpPrefix(toolName);
    for (const guard of guards) {
      const verdict = await guard(bare, input);
      if ("deny" in verdict && verdict.deny) {
        return { behavior: "deny", message: verdict.reason };
      }
    }
    return { behavior: "allow" };
  };
}

/**
 * 无效 session 的识别。
 *
 * Qoder 对一个它不认识的 sessionId 会**致命退出**（worker exit 42），stderr 里是
 * `Error resuming session: Invalid session identifier "xxx"`。
 * 上层已按 runtime 归属过滤（见 `resumableSessionId`），这里是兜底：
 * 覆盖历史脏数据与任何漏掉的路径，丢弃 resume 重跑一次，避免整轮任务白失败。
 */
export function looksLikeInvalidSession(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("invalid session identifier") || t.includes("error resuming session");
}

export class QoderRuntime implements AgentRuntime {
  async *run(input: RuntimeRunInput): AsyncGenerator<RuntimeEvent> {
    const sdk = input.sdkOptions ?? {};
    const builtinAllow = Array.isArray(sdk.builtinAllow)
      ? (sdk.builtinAllow as string[])
      : undefined;
    const controller = toController(input.abortSignal);
    // 模型档位：profile.qoderModel → config.qoder.model（buildOptions 已归并，经 sdkOptions 传来）。
    // 留空则不传 options.model，交给 Qoder 服务端默认（auto）。
    const model = typeof sdk.qoderModel === "string" ? sdk.qoderModel.trim() : "";

    // 协议工具（ask_user / report_task_done / submit_plan / …）走 in-process MCP。
    // 只换外壳，schema 与 handler 复用 Vercel 那份定义（见 qoder-protocol-tools.ts）。
    const protocolTools = (sdk.tools ?? {}) as Record<string, unknown>;
    const hasProtocol = Object.keys(protocolTools).length > 0;
    const protocol = hasProtocol ? buildQoderProtocolServer(protocolTools) : undefined;

    // 交给 CLI 的真白名单。**无条件传**（见 resolveQoderTools 注释：不传就等于开放子代理工具）
    const toolWhitelist = resolveQoderTools(builtinAllow);
    if (hasSubagentTool(toolWhitelist)) {
      // 显式声明才会走到这里。子代理内部的调用未必过 canUseTool，等于门禁有缺口，必须留痕。
      console.warn(
        `[qoder] 岗位显式声明了子代理工具（${toolWhitelist.filter((t) => SUBAGENT_TOOLS.includes(t)).join("/")}），` +
          `其内部的工具调用可能不经过门禁 —— 只在确实需要时保留这项声明。`,
      );
    }

    // 授权：内置工具用裸名，协议工具必须用 `mcp__foreman__xxx` 全名，否则模型看不到它们。
    // 外部 MCP 的授权范围（`mcp__server` / `mcp__server__tool`）本就是这个形式，直接并进来。
    const mcpAllow = Array.isArray(sdk.mcpAllow) ? (sdk.mcpAllow as string[]) : [];
    const allowedTools = [
      ...toolWhitelist,
      ...(protocol?.qualifiedNames ?? []),
      ...mcpAllow,
    ];

    /**
     * 外部 MCP（server/config/mcp.servers.json 的 stdio/http 声明）与协议 server 并存。
     * 声明形状（`{command,args,env}` / `{url}`）两边一致，原样透传即可。
     */
    const externalMcp = (sdk.mcpServers ?? {}) as Record<string, unknown>;
    const mcpServers = {
      ...externalMcp,
      ...(protocol ? { [PROTOCOL_SERVER]: protocol.server } : {}),
    };

    /**
     * 门禁（readRoots / 经验库范围 / 主干保护 …）。
     *
     * **必须无条件提供 canUseTool，哪怕一条 guard 都没有**。实测三点：
     * - `bypassPermissions` 会**绕过** canUseTool（名字即含义）→ guard 全失效，只读岗能跑 Bash；
     * - `acceptEdits` 下 canUseTool 会被调用，但**不提供它就等于无人审批 → 一律拒绝**，
     *   连正常任务都做不成（这曾让我的对照组出现假阴性：以为被 guard 拦住，其实是没人批）；
     * - 所以：模式用 acceptEdits，审批权交给这个回调，guard 为空时返回 allow。
     */
    const guards = Array.isArray(sdk.guards) ? (sdk.guards as ToolGuard[]) : [];
    const canUseTool = buildCanUseTool(guards);

    /**
     * 一次尝试。`resume` 为空表示放弃续接、开新会话。
     * 抽成闭包是为了「无效 session → 丢弃 resume 再跑一次」能原样复用同一套选项。
     */
    const attempt = async function* (
      this: void,
      resume: string | undefined,
    ): AsyncGenerator<RuntimeEvent, { invalidSession: boolean }> {
      // stderr 必须接：SDK 的进程错误只带 exit code，真正的原因在 stderr 尾部。
      // 不接的话线上只能看到「exited with code 42」这种无从下手的信息（真实踩过）。
      const stderrChunks: string[] = [];
      const messages = query({
        prompt: input.prompt,
        options: {
          auth: resolveQoderAuth(input.env),
          /**
           * **`tools` 才是真限制**（映射到 CLI 的 `--tools`），`allowedTools` 只是免审批清单。
           * 实测：`tools:['Read']` 下模型完全拿不到 Bash；而只设 `allowedTools:[]`
           * 一点约束都没有，Bash 照样可用。只读岗位的边界全靠这一行，不能退回 allowedTools。
           */
          tools: toolWhitelist,
          allowedTools,
          /**
           * 与 Vercel 侧「门禁由我们判、不靠人工审批」同一意图，但**不能用 bypassPermissions**：
           * 那个模式会绕过 canUseTool，guard 直接失效（实测只读岗照样能跑 Bash 写文件）。
           * 用 acceptEdits 让待审批操作走到 canUseTool，再由我们的 guard 链裁决。
           */
          permissionMode: "acceptEdits",
          canUseTool,
          stderr: (d: string) => {
            stderrChunks.push(d);
            if (stderrChunks.length > 200) stderrChunks.shift();
          },
          ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
          ...(model ? { model } : {}),
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          ...(input.maxSteps ? { maxTurns: input.maxSteps } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(resume ? { resume } : {}),
          ...(input.env ? { env: input.env as Record<string, string> } : {}),
          ...(controller ? { abortController: controller } : {}),
          // 外部会话存储：transcript 镜像到 runtimeDir，qodercli 改跑临时 QODER_CONFIG_DIR，
          // 不再往用户 IDE 的 ~/.qoder/projects/ 写历史（登录态仍走 qodercliAuth 复用）。
          sessionStore: getQoderSessionStore(),
        },
      });

      /**
       * 提问 / 交卷是**终止信号**：工具入参已承载完整内容，不该让模型在工具结果之后
       * 再开一轮生成第二份不会被转发的总结（既丢信息又烧 token）。
       * Vercel 侧靠 `stopWhen: [hasToolCall(...)]` 表达，Qoder 没有等价选项，
       * 只能在消息循环里自己收口：见到这两个工具调用就 close 掉会话。
       */
      let terminal = false;
      try {
        for await (const msg of messages) {
          for (const ev of translateMessage(msg)) {
            yield ev;
            if (ev.event === "tool_call" && TERMINAL_TOOLS.has(String(ev.data.name))) {
              terminal = true;
            }
          }
          if (terminal) break;
        }
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const stderrTail = stderrChunks.join("").trim();
        const detail = `${rawMessage}${stderrTail ? `\n${stderrTail}` : ""}`;
        // 只有「带着 resume 跑」且确实是无效 session 才值得重试；否则如实抛给外层
        if (resume && looksLikeInvalidSession(detail)) return { invalidSession: true };
        // worker 非零退出（非 42）且没吐 stderr：退出码本身零线索，补足上下文供事后归因，
        // 否则线上只能看到一句「exited with code N」无从下手（真实踩过，task 2a1839）。
        const exit = workerExitCode(rawMessage);
        if (exit !== undefined && exit !== 42 && !stderrTail) {
          throw new Error(
            `${rawMessage}（worker 无 stderr 输出，多为子进程崩溃/被杀或长连接中断）` +
              `\n上下文：cwd=${input.cwd ?? "?"} · model=${model || "auto"} · ` +
              `mcp=${Object.keys(mcpServers).length} · tools=${toolWhitelist.length} · ` +
              `resume=${resume ? "是" : "否"}`,
          );
        }
        throw new Error(detail.trim());
      } finally {
        // 提前 break / 出错时必须显式关，否则 worker 子进程留在后台
        await messages.close().catch(() => {});
      }
      return { invalidSession: false };
    };

    try {
      const first = yield* attempt(input.resume);
      if (first.invalidSession) {
        console.warn(
          `[qoder] 会话 ${input.resume} 在 Qoder 侧不存在（多为切换 runtime 前留下的异源 id），` +
            `已丢弃它重开一轮。`,
        );
        yield {
          event: "notice",
          data: { level: "warn", message: "上一轮会话无法续接，已开新会话继续。" },
        };
        yield* attempt(undefined);
      }
    } catch (error) {
      yield errorResult(error);
    }
  }

  /**
   * 单轮无工具调用（路由 / 验收 / 裁决 / 反馈识别 / onboarding 连通性）。
   *
   * 用 `query()` + 空 allowedTools 实现，**刻意不回落 Vercel**：回落就又需要
   * ANTHROPIC 凭据，违背「只用 Qoder 账号 token」的目的。
   */
  async complete(input: RuntimeCompleteInput): Promise<RuntimeCompleteResult> {
    const parts: string[] = [];
    let sessionId: string | undefined;
    let isError = false;

    const controller = toController(input.abortSignal);
    // complete() 没有 sdkOptions（不经 buildOptions），直接取全局档位。
    // 岗位级 qoderModel 不适用于此：路由/裁决/验收是主管的轻量调用，不属于任何岗位。
    const model = config.qoder.model?.trim();

    try {
      const messages = query({
        prompt: input.prompt,
        options: {
          auth: resolveQoderAuth(input.env),
          /**
           * 单轮直答（路由 / 验收 / 裁决 / 反馈识别）不需要任何工具。
           * `tools: []` 才是真限制（只给 allowedTools 拦不住），两者都置空双保险；
           * canUseTool 也照样提供 —— 万一模型仍拿到某个工具，这里一律拒，
           * 且与 run() 同一套判据，不给「单轮通道」留一条无门禁的后门。
           */
          tools: [],
          allowedTools: [],
          // 单轮调用从不 resume：设 ephemeral，既不往 ~/.qoder 落历史，也无需外部存储
          persistSession: false,
          permissionMode: "acceptEdits",
          canUseTool: denyAllTools,
          ...(model ? { model } : {}),
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.resume ? { resume: input.resume } : {}),
          ...(input.env ? { env: input.env as Record<string, string> } : {}),
          ...(controller ? { abortController: controller } : {}),
        },
      });

      for await (const msg of messages) {
        for (const ev of translateMessage(msg)) {
          if (ev.event === "text") parts.push(String(ev.data.text ?? ""));
          else if (ev.event === "session") sessionId = String(ev.data.sessionId ?? "");
          else if (ev.event === "result") {
            if (ev.data.isError === true) isError = true;
            if (typeof ev.data.sessionId === "string") sessionId = ev.data.sessionId;
            // 没有任何 text 块时（纯 result 交付）回落用 result 文本，避免返回空串
            if (!parts.length && typeof ev.data.result === "string") parts.push(ev.data.result);
          }
        }
      }
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error),
        isError: true,
        ...(sessionId ? { sessionId } : {}),
      };
    }

    return {
      text: parts.join("").trim(),
      isError,
      ...(sessionId ? { sessionId } : {}),
    };
  }
}
