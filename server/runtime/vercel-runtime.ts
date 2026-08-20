import {
  generateText,
  hasToolCall,
  streamText,
  isStepCount,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { credentialGuidance } from "../core/onboarding.js";
import type {
  AgentRuntime,
  RuntimeCompleteInput,
  RuntimeCompleteResult,
  RuntimeEvent,
  RuntimeRunInput,
} from "./types.js";
import { applyGuards, type ToolGuard } from "./hooks.js";
import { isRetryableError } from "./transient.js";
import { mcpToolAllowed, splitMcpPatterns } from "../core/audit.js";
import {
  compactIfNeeded,
  estimateTokens,
  generateSessionId,
  loadSession,
  sanitizeSessionMessages,
  saveSession,
  type SessionMessage,
  type SessionState,
} from "./session-store.js";
import { config } from "../config/index.js";
import { buildGrepTool } from "./tools/grep.js";
import { buildFilesystemTools } from "./tools/filesystem.js";
import { buildTodoWriteTool } from "./tools/todo-write.js";
import { ASK_USER_TOOL } from "../tools/ask-user.js";
import { REPORT_DONE_TOOL } from "../tools/task-report.js";
import { SUBMIT_STEP_TOOL } from "../tools/step-report.js";

/**
 * MCP server 声明（从 mcp.servers.json 加载的格式）
 */
interface McpServerDecl {
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * 工具袋的键就是展示名（Grep / TodoWrite）。这张表只承接历史遗留的小写实现名，
 * 让早先按 `grep` / `todo_write` 写的白名单继续生效。
 */
const BUILTIN_ALIAS: Record<string, string> = {
  grep: "Grep",
  todo_write: "TodoWrite",
};

/** 按白名单裁剪内置工具袋；白名单为空/未给 = 全部放行（未声明 tools 的岗位保持原行为） */
function filterBuiltins(
  builtins: Record<string, unknown>,
  allow?: string[],
): Record<string, unknown> {
  if (!allow?.length) return builtins;
  const names = new Set(allow.map((n) => BUILTIN_ALIAS[n] ?? n));
  return Object.fromEntries(Object.entries(builtins).filter(([k]) => names.has(k)));
}

/** 缓存保留档位。short=5 分钟（Anthropic 默认），long=1 小时（需 extended-cache-ttl beta）。 */
export type CacheRetention = "short" | "long";

/**
 * 档位 → TTL。
 *
 * 为什么要分档而不是一律 long：写入按 1.25x（5m）/ 2x（1h）计费，读取只要 0.1x。
 * 1h 只对「一小时内会被 resume」的岗位划算；对单发或低频岗位（实测 default 读写比 0.70、
 * 平均 2.8 步；定时的复盘/优化员间隔 24 小时~7 天）2x 的写入费永远等不到复用，纯亏。
 *
 * 注意收益的主要来源是**一次 run 内的多步工具循环**（步与步间隔秒级，5m 绰绰有余），
 * 实测读写比与平均步数几乎线性相关。跨 run 复用才是 1h 要解决的问题。
 *
 * 若网关不支持 extended-cache-ttl beta（表现为请求被拒或 1h 不生效），把 long 也映射成
 * "5m" 即可，断点位置与 TTL 无关、不受影响。
 */
function ttlOf(retention: CacheRetention | undefined): "5m" | "1h" {
  return retention === "long" ? "1h" : "5m";
}

/**
 * 断点间隔（content block 数）。
 *
 * Anthropic 每个断点只往前回溯 **20 个 content block** 去匹配已有缓存，超窗口就**静默 miss**
 * ——不报错，只是这次按全价重算。工具循环里模型一次并行调多个工具，一步就能造出 20+ 个
 * block 跨过窗口，所以中间要铺锚点。取 15 留余量。
 */
const BLOCK_STRIDE = 15;
/** Anthropic 每请求最多 4 个断点，system 占 1 个，剩 3 个给 messages */
const MAX_MESSAGE_BREAKPOINTS = 3;

type WithProviderOptions = {
  providerOptions?: Record<string, Record<string, unknown>>;
};

/** 摘掉上一步打的断点。prepareStep 的 messages 会带着我们的改动流转到后续步骤，
 *  不先摘就会一步累加一个，超过 4 个上限后 SDK 只 warn 然后丢弃——白付写入费。 */
function stripCacheControl(message: ModelMessage): ModelMessage {
  const po = (message as WithProviderOptions).providerOptions;
  if (!po?.anthropic || !("cacheControl" in po.anthropic)) return message;
  const { cacheControl: _dropped, ...restAnthropic } = po.anthropic;
  return { ...message, providerOptions: { ...po, anthropic: restAnthropic } } as ModelMessage;
}

function markCacheBreakpoint(message: ModelMessage, ttl: "5m" | "1h"): ModelMessage {
  const po = (message as WithProviderOptions).providerOptions ?? {};
  return {
    ...message,
    providerOptions: {
      ...po,
      anthropic: {
        ...(po.anthropic ?? {}),
        cacheControl: { type: "ephemeral", ttl },
      },
    },
  } as ModelMessage;
}

/** 一条消息占几个 content block（纯字符串 content 算 1 个） */
function blockCount(message: ModelMessage): number {
  return Array.isArray(message.content) ? message.content.length : 1;
}

/**
 * 打缓存断点。cache_control 标记的是**前缀边界**——命中时从头读到该块为止。
 * 配合 cachedInstructions 一共用满 4 个额度：
 * - instructions（system）1 个：静态前缀。Anthropic 的请求顺序是 tools → system → messages，
 *   标在 system 上等于把工具定义一起圈进缓存。只随「天 / 经验库 / 知识库」变。
 * - messages 里最多 3 个：从末尾往前每 BLOCK_STRIDE 个 block 一个。末尾那个是滚动边界
 *   （把本轮新增的增量写进缓存供下次读），往前的是锚点（保证相邻请求的断点距离不超过
 *   20-block 回溯窗口）。
 *
 * 迁到 VercelRuntime 后这里一个 cacheControl 都没传过，缓存命中率从旧运行时的 87% 掉到 1.5%、
 * 每 run 等效输入从 15 万涨到 94 万——不是调优问题，是把丢掉的能力接回来。
 */
function withCacheBreakpoints(messages: ModelMessage[], ttl: "5m" | "1h"): ModelMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.map(stripCacheControl);
  let marked = 0;
  /**
   * 候选消息的末尾与「上一个已打断点」之间隔了多少个 block。
   * 断点落在一条消息的**最后一个** content block 上，所以在 i 处打点后，
   * 对下一个候选 i-1 来说，中间隔着的正是消息 i 自己的 block 数 —— 置 size 而不是 0。
   * （早先这里清零，遇到「12 block + 12 block」两条消息时锚点永远不触发，
   * 相邻请求的断点间距 24 > 20，照样静默 miss。）
   */
  let since = 0;
  for (let i = out.length - 1; i >= 0 && marked < MAX_MESSAGE_BREAKPOINTS; i--) {
    const size = blockCount(out[i]);
    // 末尾必打（滚动边界）；其余位置在「跳过它会让间距超标」时补锚点
    if (i === out.length - 1 || since + size > BLOCK_STRIDE) {
      out[i] = markCacheBreakpoint(out[i], ttl);
      marked++;
      since = size;
    } else {
      since += size;
    }
  }
  return out;
}

/**
 * 把 system prompt 包成带缓存断点的 system 消息。
 * ai@7 不允许在 messages 里塞 system（会抛 InvalidPromptError），只能走 instructions；
 * 而 instructions 支持 SystemModelMessage，这是给 system 块挂 cache_control 的唯一入口
 * （传纯字符串就挂不上）。
 */
function cachedInstructions(systemPrompt: string, ttl: "5m" | "1h"): SystemModelMessage {
  return markCacheBreakpoint({ role: "system", content: systemPrompt }, ttl) as SystemModelMessage;
}

/**
 * Vercel AI SDK 实现——provider-agnostic 的 LLM runtime。
 * run(): 多轮 agent loop（streamText + MCP tools + inline tools + guards + session）
 * complete(): 单轮无工具（boss think / router）
 */
export class VercelRuntime implements AgentRuntime {
  async *run(input: RuntimeRunInput): AsyncGenerator<RuntimeEvent> {
    const model = this.resolveModel(input.model, input.env);
    const maxSteps = input.maxSteps ?? config.maxTurns ?? 50;

    const opts = (input.sdkOptions ?? {}) as {
      tools?: ToolSet;
      /** 内置工具白名单（profile.tools 的名称数组）；未给 = 不限制 */
      builtinAllow?: string[];
      /** MCP 授权范围（mcp__server / mcp__server__tool）；未给 = 不限制，空数组 = 全不授权 */
      mcpAllow?: string[];
      guards?: ToolGuard[];
      systemPrompt?: string;
      sessionKey?: string;
      mcpServers?: Record<string, McpServerDecl>;
      /** 缓存保留档位（来自 profile.cacheRetention）；未给 = short(5m) */
      cacheRetention?: CacheRetention;
    };

    // ─── MCP tools（filesystem + shell + fetch + 其它配置的 MCP servers） ───
    const mcpClients: Array<{ name: string; client: Awaited<ReturnType<typeof createMCPClient>> }> = [];
    const mcpTools: Record<string, unknown> = {};

    if (opts.mcpServers) {
      // MCP 授权范围：未授权的工具**根本不注册**，模型看不见 = 不会调 = 不烧 token。
      // MCP server 是全局挂载的（浏览器自动化对所有岗位可见），不过这道筛子，
      // 一个「只读」岗位照样能去点页面 / 执行页面 JS。
      const scope = opts.mcpAllow ? splitMcpPatterns(opts.mcpAllow) : undefined;
      // 排序注册：工具定义在请求里排在 tools → system → messages 的最前面，
      // 顺序一变就作废**整条** prompt cache 前缀（失效层级最高的一类）。
      // server 遍历顺序取决于配置对象的插入顺序、server 内工具顺序取决于 tools/list 的返回，
      // 两者都不该被信任，统一按名字排序。
      const serverNames = Object.keys(opts.mcpServers).sort();
      for (const name of serverNames) {
        const decl = opts.mcpServers[name];
        try {
          const client = await this.connectMcp(name, decl, input.cwd);
          mcpClients.push({ name, client });
          const tools = await client.tools();
          for (const toolName of Object.keys(tools).sort()) {
            if (scope && !mcpToolAllowed(toolName, scope)) continue;
            mcpTools[toolName] = tools[toolName];
          }
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          console.warn(`[vercel-runtime] MCP "${name}" 连接失败，跳过:`, reason);
          // 必须让上层看见：本次工具袋静默少了一批工具（模型能力被削），
          // 且工具定义变化会作废整条 prompt cache 前缀——这两件事都不该只留在控制台里。
          yield {
            event: "notice",
            data: {
              level: "warn",
              message: `MCP "${name}" 连接失败，本次工具袋缺少该 server 的工具（并会导致 prompt cache 前缀失效）：${reason}`,
            },
          };
        }
      }
    }

    // ─── Inline tools（文件系统 + grep + todo + 协议工具） ───
    const sessionKey = opts.sessionKey ?? generateSessionId();
    // 按本次 run 的工作目录构建：相对路径必须与路径门禁同一个判定基准，
    // 否则守卫按 runCwd 校验、工具按 process.cwd() 执行，门禁可被绕过
    const toolCwd = input.cwd ?? process.cwd();
    const fsTools = buildFilesystemTools(toolCwd);
    const builtins: Record<string, unknown> = {
      Read: fsTools.readTool,
      Write: fsTools.writeTool,
      Edit: fsTools.editTool,
      Glob: fsTools.globTool,
      Bash: fsTools.bashTool,
      Grep: buildGrepTool(toolCwd),
      TodoWrite: buildTodoWriteTool(sessionKey),
    };
    const inlineTools: Record<string, unknown> = {
      // 白名单是**真限制**：不在名单里的内置工具根本不进工具袋。
      // 只在提示词里说「你只有只读权限」是无效的——工具袋里有 Bash，模型就会用。
      ...filterBuiltins(builtins, opts.builtinAllow),
      // 协议工具（交卷/提问/委派）永远放行：不给它们，协议就是空头承诺
      ...(opts.tools ?? {}),
    };

    // 合并所有工具：MCP tools + inline tools。
    // **按名字排序**：tools 排在请求最前面，顺序一变就作废整条 prompt cache 前缀。
    // protocolTools 是按场景条件挂载的（ask_user / report_task_done / schedule_later / Task
    // 各有各的判断），插入顺序天然会抖，不能直接信。
    const allTools = Object.fromEntries(
      Object.entries({ ...mcpTools, ...inlineTools }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ) as ToolSet;

    // Apply guards（审计/路径门禁/分支保护）
    const tools = opts.guards?.length
      ? applyGuards(allTools, opts.guards)
      : allTools;

    // ─── Session ───
    let session: SessionState | undefined;
    if (input.resume) {
      session = loadSession(input.resume);
    }
    if (!session) {
      session = {
        id: sessionKey,
        messages: [],
        activatedSkills: [],
        tokenEstimate: 0,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
    }

    yield { event: "session", data: { sessionId: session.id } };

    // System prompt
    const systemPrompt = opts.systemPrompt ?? input.systemPrompt;

    // Messages
    const messages: SessionMessage[] = [...session.messages];
    messages.push({ role: "user", content: input.prompt });

    // Context compression
    session.messages = messages;
    session.tokenEstimate = estimateTokens(messages);
    const ttl = ttlOf(opts.cacheRetention);
    const {
      state: compactedSession,
      compacted,
      reason: compactReason,
    } = await compactIfNeeded(session, {
      windowTokens: config.compact.contextWindow,
      atPercent: config.compact.atPercent,
      hardAtPercent: config.compact.hardAtPercent,
      cacheTtlMs: ttl === "1h" ? 3_600_000 : 300_000,
      summarize: (text) => summarizeTranscript(model, text),
    });
    if (compacted) {
      session = compactedSession;
      yield {
        event: "compact",
        data: {
          trigger: `pre-call:${compactReason}`,
          preTokens: estimateTokens(messages),
          postTokens: session.tokenEstimate,
        },
      };
    }

    // 先落用户输入，再发模型请求。即使首个流 chunk 就报错，resume 也有本轮诉求，
    // 不会出现「任务记得 sessionId，但 session 文件根本不存在」的断层。
    session.lastActiveAt = Date.now();
    session.checkpoint = {
      state: "running",
      completedSteps: 0,
      updatedAt: session.lastActiveAt,
    };
    if (input.persistSession) saveSession(session);

    // ─── streamText ───
    try {
      let checkpointedResponseCount = 0;
      const result = streamText({
        model,
        // 走 instructions 而不是已废弃的 system：只有 SystemModelMessage 形态
        // 能给 system 块挂上 cache_control 断点
        ...(systemPrompt ? { instructions: cachedInstructions(systemPrompt, ttl) } : {}),
        messages: withCacheBreakpoints(session.messages as ModelMessage[], ttl),
        tools,
        // 提问/交卷都是终止信号（submit_step 是编队内对组长交卷，同理）。工具参数已承载
        // 完整内容，禁止 SDK 在工具结果后再开一个模型 step 生成不会被业务层转发的
        // 第二份总结（既丢信息又浪费 token）。
        stopWhen: [
          isStepCount(maxSteps),
          hasToolCall(ASK_USER_TOOL),
          hasToolCall(REPORT_DONE_TOOL),
          hasToolCall(SUBMIT_STEP_TOOL),
        ],
        // 多步工具循环里每步都要把滚动断点前移到新的末尾，否则本步新增的
        // 工具结果没有断点收口 = 下一步只能当全新输入重付一次
        prepareStep: ({ messages: stepMessages }) => ({
          messages: withCacheBreakpoints(stepMessages, ttl),
        }),
        // 每个完整 step（含结构化 assistant/tool 消息）立即形成检查点。
        // 当前 step 若流式中断，只丢弃这个未完成 step；此前工具循环均可 resume。
        onStepEnd: ({ response }) => {
          const stepMessages = response.messages as SessionMessage[];
          session.messages.push(...stepMessages);
          checkpointedResponseCount += stepMessages.length;
          session.messages = sanitizeSessionMessages(session.messages);
          session.tokenEstimate = estimateTokens(session.messages);
          session.lastActiveAt = Date.now();
          session.checkpoint = {
            state: "running",
            completedSteps: (session.checkpoint?.completedSteps ?? 0) + 1,
            updatedAt: session.lastActiveAt,
          };
          if (input.persistSession) saveSession(session);
        },
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });

      // 流内错误必须捕获：AI SDK 把 API 错误发成 error chunk 而非抛异常，
      // 漏掉它会让「限流 / 鉴权失败」伪装成「员工没有任何输出」（真实事故：任务 7a178c）
      let streamError: unknown;
      let sawToolCall = false;

      for await (const chunk of result.fullStream) {
        switch (chunk.type) {
          case "text-delta":
            yield { event: "text", data: { text: chunk.text } };
            break;
          case "tool-call":
            sawToolCall = true;
            yield {
              event: "tool_call",
              data: { id: chunk.toolCallId, name: chunk.toolName, input: chunk.input },
            };
            break;
          case "tool-result":
            yield {
              event: "tool_result",
              data: { toolUseId: chunk.toolCallId, content: chunk.output },
            };
            break;
          // 工具名不存在或 execute 抛异常时 SDK 只发这一个 chunk。不转发的话
          // trace / SSE 里会留下一个永不返回的调用，观测方看不出这步失败过
          case "tool-error":
            yield {
              event: "tool_result",
              data: {
                toolUseId: chunk.toolCallId,
                isError: true,
                content: describeError(chunk.error),
              },
            };
            break;
          case "reasoning-delta":
            yield { event: "thinking", data: { text: chunk.text } };
            break;
          case "error":
            streamError = chunk.error;
            break;
        }
      }

      if (streamError) {
        const info = classifyRuntimeError(streamError);
        session.lastActiveAt = Date.now();
        session.checkpoint = {
          state: "interrupted",
          completedSteps: session.checkpoint?.completedSteps ?? 0,
          updatedAt: session.lastActiveAt,
          error: info,
        };
        if (input.persistSession) saveSession(session);
        console.error("[vercel-runtime] 流内错误:", info.message);
        yield {
          event: "result",
          data: {
            subtype: "error",
            isError: true,
            result: info.message,
            sessionId: session.id,
            errorSource: info.source,
            retryable: info.retryable,
            ...(info.statusCode ? { statusCode: info.statusCode } : {}),
          },
        };
        return;
      }

      const finalText = await result.text;
      const usage = await result.usage;
      const steps = await result.steps;

      // 空输出不是成功交付：宁可如实报错，也不要让上层把「什么都没干」当成品验收。
      // emptyOutput 供上层区别对待——员工任务照旧判失败，而 boss 的一轮对话可以沿原 session
      // 重试一次要它把话说出来（实测模型的输出通道会间歇性抽风：reasoning 正常但 text 为空）。
      if (!finalText.trim() && !sawToolCall) {
        const message = "模型没有产生任何输出（无文本、无工具调用），本轮视为失败";
        session.lastActiveAt = Date.now();
        session.checkpoint = {
          state: "interrupted",
          completedSteps: session.checkpoint?.completedSteps ?? 0,
          updatedAt: session.lastActiveAt,
          error: { source: "model_gateway", retryable: true, message },
        };
        if (input.persistSession) saveSession(session);
        yield {
          event: "result",
          data: {
            subtype: "error",
            isError: true,
            emptyOutput: true,
            retryable: true,
            errorSource: "model_gateway",
            result: message,
            sessionId: session.id,
          },
        };
        return;
      }

      // 模型偶发把工具调用 XML 吐进文本通道：工具从未执行，但 finalText 非空，
      // 上一段的空输出兜底接不住，会被当成功交付。同族问题同样判失败并允许重试。
      if (!sawToolCall && looksLikePseudoToolCall(finalText)) {
        const message =
          "模型把工具调用写成了文本（未真正发起调用），本轮视为失败";
        session.lastActiveAt = Date.now();
        session.checkpoint = {
          state: "interrupted",
          completedSteps: session.checkpoint?.completedSteps ?? 0,
          updatedAt: session.lastActiveAt,
          error: { source: "model_gateway", retryable: true, message },
        };
        if (input.persistSession) saveSession(session);
        yield {
          event: "result",
          data: {
            subtype: "error",
            isError: true,
            malformedToolCall: true,
            retryable: true,
            errorSource: "model_gateway",
            result: message,
            sessionId: session.id,
          },
        };
        return;
      }

      // Session 持久化：用 AI SDK 的 responseMessages（结构化 ResponseMessage[]），
      // 不要手工把 tool call/result stringify 成文本——那种格式违反 API 协议，
      // 会让该 session 之后每次 resume 都返回空（真实事故：session e08d353f）
      const responseMessages = await result.responseMessages;
      // onStepEnd 已逐步保存；这里只补 SDK 可能未触发 callback 的尾部消息，避免重复回放。
      session.messages.push(
        ...((responseMessages as SessionMessage[]).slice(checkpointedResponseCount)),
      );
      session.messages = sanitizeSessionMessages(session.messages);
      session.tokenEstimate = estimateTokens(session.messages);
      session.lastActiveAt = Date.now();
      session.checkpoint = {
        state: "completed",
        completedSteps: steps.length,
        updatedAt: session.lastActiveAt,
      };
      if (input.persistSession) {
        saveSession(session);
      }

      yield {
        event: "result",
        data: {
          subtype: "success",
          isError: false,
          result: finalText,
          sessionId: session.id,
          numTurns: steps.length,
          usage,
        },
      };
    } catch (error) {
      const info = classifyRuntimeError(error);
      session.lastActiveAt = Date.now();
      session.checkpoint = {
        state: "interrupted",
        completedSteps: session.checkpoint?.completedSteps ?? 0,
        updatedAt: session.lastActiveAt,
        error: info,
      };
      if (input.persistSession) saveSession(session);
      if (isReportableError(error)) {
        yield {
          event: "result",
          data: {
            subtype: "error",
            isError: true,
            result: info.message,
            sessionId: session.id,
            errorSource: info.source,
            retryable: info.retryable,
            ...(info.statusCode ? { statusCode: info.statusCode } : {}),
          },
        };
      } else {
        throw error;
      }
    } finally {
      // 关闭 MCP clients
      for (const { name, client } of mcpClients) {
        try {
          await client.close();
        } catch (e) {
          console.warn(`[vercel-runtime] MCP "${name}" 关闭失败:`, e);
        }
      }
    }
  }

  async complete(input: RuntimeCompleteInput): Promise<RuntimeCompleteResult> {
    const model = this.resolveModel(input.model, input.env);

    // Session：无 resume/persistSession 时保持原有单轮无状态语义（路由/验收/裁决走这条）
    const stateful = Boolean(input.resume || input.persistSession);
    let session: SessionState | undefined;
    if (stateful) {
      if (input.resume) session = loadSession(input.resume);
      session ??= {
        id: generateSessionId(),
        messages: [],
        activatedSkills: [],
        tokenEstimate: 0,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      session.messages.push({ role: "user", content: input.prompt });
      session.tokenEstimate = estimateTokens(session.messages);
      const { state } = await compactIfNeeded(session, {
        windowTokens: config.compact.contextWindow,
        atPercent: config.compact.atPercent,
        hardAtPercent: config.compact.hardAtPercent,
        // complete() 没有岗位级档位（路由/验收/裁决都是单轮），按默认 short 的 5 分钟算
        cacheTtlMs: 300_000,
        summarize: (text) => summarizeTranscript(model, text),
      });
      session = state;
      session.lastActiveAt = Date.now();
      session.checkpoint = {
        state: "running",
        completedSteps: 0,
        updatedAt: session.lastActiveAt,
      };
      if (input.persistSession) saveSession(session);
    }

    for (let attempt = 0; attempt <= COMPLETE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const result = await generateText({
          model,
          system: input.systemPrompt,
          ...(session
            ? { messages: session.messages as ModelMessage[] }
            : { prompt: input.prompt }),
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        });

        if (session) {
          session.messages.push(...((await result.responseMessages) as SessionMessage[]));
          session.messages = sanitizeSessionMessages(session.messages);
          session.tokenEstimate = estimateTokens(session.messages);
          session.lastActiveAt = Date.now();
          session.checkpoint = {
            state: "completed",
            completedSteps: 1,
            updatedAt: session.lastActiveAt,
          };
          if (input.persistSession) saveSession(session);
          return { text: result.text, sessionId: session.id, isError: false };
        }
        return { text: result.text, isError: false };
      } catch (error) {
        const info = classifyRuntimeError(error);
        if (info.retryable && attempt < COMPLETE_RETRY_DELAYS_MS.length) {
          await waitMs(COMPLETE_RETRY_DELAYS_MS[attempt], input.abortSignal);
          continue;
        }
        if (session) {
          session.lastActiveAt = Date.now();
          session.checkpoint = {
            state: "interrupted",
            completedSteps: 0,
            updatedAt: session.lastActiveAt,
            error: info,
          };
          if (input.persistSession) saveSession(session);
        }
        if (isReportableError(error)) {
          return {
            text: info.message,
            ...(session ? { sessionId: session.id } : {}),
            isError: true,
          };
        }
        throw error;
      }
    }
    throw new Error("模型调用重试循环意外结束");
  }

  /** 连接一个 MCP server（stdio 或 http/sse） */
  private async connectMcp(name: string, decl: McpServerDecl, cwd?: string) {
    if (decl.type === "stdio" && decl.command) {
      // 展开 ${WORKING_DIR} 等环境变量占位
      const args = (decl.args ?? []).map((a) =>
        a.replace(/\$\{WORKING_DIR\}/g, cwd || process.cwd()),
      );
      const env: Record<string, string> = { ...process.env as Record<string, string> };
      if (decl.env) {
        for (const [k, v] of Object.entries(decl.env)) {
          env[k] = v.replace(/\$\{(\w+)\}/g, (_m, key: string) => process.env[key] ?? "");
        }
      }
      const transport = new StdioMCPTransport({
        command: decl.command,
        args,
        env,
        cwd,
      });
      return createMCPClient({ transport });
    }
    // http/sse
    if (decl.url) {
      return createMCPClient({
        transport: { type: decl.type as "http" | "sse", url: decl.url, headers: decl.headers },
      });
    }
    throw new Error(`MCP "${name}": 无效的声明（stdio 缺 command / http 缺 url）`);
  }

  private resolveModel(modelId: string | undefined, env?: Record<string, string>) {
    const e = env ?? (process.env as Record<string, string>);
    const baseUrl = e.ANTHROPIC_BASE_URL;
    const authToken = e.ANTHROPIC_AUTH_TOKEN;
    const apiKey = e.ANTHROPIC_API_KEY;
    const openaiKey = e.OPENAI_API_KEY;

    if (authToken || apiKey) {
      // AI SDK 的 anthropic provider 会在 baseURL 后追加 /messages
      // idealab 网关的完整路径是 .../api/code/v1/messages，所以 baseURL = .../api/code/v1
      let adjustedBaseUrl = baseUrl?.replace(/\/+$/, "");
      if (adjustedBaseUrl && !adjustedBaseUrl.endsWith("/v1")) {
        adjustedBaseUrl = `${adjustedBaseUrl}/v1`;
      }
      // AI SDK 会覆盖 headers 里的 User-Agent，必须通过 custom fetch 强制设置
      const gatewayFetch: typeof globalThis.fetch = async (input, init) => {
        const headers = new Headers(init?.headers as HeadersInit);
        headers.set("User-Agent", "@anthropic-ai/claude-code");
        return globalThis.fetch(input, { ...init, headers });
      };
      const anthropic = createAnthropic({
        apiKey: authToken || apiKey,
        ...(adjustedBaseUrl ? { baseURL: adjustedBaseUrl } : {}),
        headers: {
          "anthropic-client-platform": "claude_code_cli",
          // 两个都是 **opt-in beta**，SDK 不会自动加（它只自动加 files-api / skills 那几个）：
          // - context-1m：1M 上下文窗口。不带这个头 API 侧一律只给 200k，
          //   本地 compact.contextWindow 配多大都没用（那只是压缩阈值的记账基数）。
          // - extended-cache-ttl：允许 cache_control.ttl 取 "1h"（默认只有 5m）。
          // SDK 会把这里的 beta 与它自己需要的 beta 取并集，不会互相覆盖。
          "anthropic-beta": "context-1m-2025-08-07,extended-cache-ttl-2025-04-11",
        },
        fetch: gatewayFetch,
      });
      return anthropic(modelId || config.model || "claude-opus-5");
    }
    if (openaiKey) {
      const openai = createOpenAI({ apiKey: openaiKey });
      return openai(modelId || "gpt-4o");
    }
    if (baseUrl) {
      const compat = createOpenAI({ baseURL: baseUrl, apiKey: "ollama" });
      return compat(modelId || "llama3");
    }
    throw new Error(credentialGuidance());
  }
}

const COMPLETE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * 压缩用的对话摘要。保留「事实 / 已做的决定 / 未收尾的线索」，
 * 这三类是续跑时真正需要的；寒暄与过程性措辞可丢。
 */
async function summarizeTranscript(
  model: Parameters<typeof generateText>[0]["model"],
  transcript: string,
): Promise<string> {
  const result = await generateText({
    model,
    prompt: [
      "把下面这段对话压缩成简洁摘要，供后续续接对话使用。",
      "必须保留：已确认的事实与数据、已做出的决定与取舍、尚未收尾的问题或待办、涉及的路径/编号/命令（原样保留不要改写）。",
      "可以丢弃：寒暄、过程性措辞、重复表述。",
      "直接输出摘要正文，不要加前言。",
      "",
      transcript.slice(0, 20000),
    ].join("\n"),
  });
  return result.text;
}

/**
 * 模型是否把工具调用 XML 写进了文本通道（工具实际从未执行）。
 * 先剥掉围栏代码块与行内代码：正常回答里解释调用语法时 XML 是放在代码块里的，
 * 不剥会把这类回答误判成失败。
 */
export function looksLikePseudoToolCall(text: string): boolean {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  return /<\/?(?:antml:)?invoke\b/.test(prose);
}

/**
 * 提取错误的可读原因。
 * AI SDK 的 APICallError 把网关原文放在 responseBody，message 常常是空串——
 * 只读 message 会得到「调用失败：」这种没有信息量的报错。
 */
function describeError(error: unknown): string {
  if (!error) return "未知错误";
  const e = error as {
    message?: string;
    statusCode?: number;
    responseBody?: string;
    cause?: unknown;
  };
  const status = e.statusCode ? `[${e.statusCode}] ` : "";
  const body = e.responseBody?.trim();
  if (body) {
    // 网关多为 JSON，优先取其中的 message 字段，取不到就用原文
    try {
      const parsed = JSON.parse(body) as { message?: string; detailMessage?: string };
      const msg = parsed.detailMessage || parsed.message;
      if (msg) return `${status}${msg}`;
    } catch {
      /* 非 JSON，落到原文 */
    }
    return `${status}${body.slice(0, 300)}`;
  }
  if (e.message?.trim()) return `${status}${e.message}`;
  if (e.cause) return `${status}${describeError(e.cause)}`;
  return `${status}${String(error).slice(0, 200)}`;
}

/**
 * 可识别、可上报错误判定：命中则以 isError 形式交回上层（由 boss 决定重试或播报），
 * 否则原样抛出走异常链路。
 * 注意：必须看 statusCode 与 responseBody——网关的限流提示是中文且只在 responseBody 里，
 * 靠英文关键字匹配 message 一个都命中不了（真实事故：「超过了10次/60.0分钟」被漏判）。
 */
function isReportableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { message?: string; statusCode?: number; responseBody?: string };
  if (e.statusCode && [401, 403, 408, 429, 500, 502, 503, 504].includes(e.statusCode)) {
    return true;
  }
  const haystack = `${e.message ?? ""} ${e.responseBody ?? ""}`.toLowerCase();
  const patterns = [
    "401",
    "403",
    "429",
    "500",
    "502",
    "503",
    "timeout",
    "econnrefused",
    "fetch failed",
    "rate limit",
    "too many requests",
    "quota",
    // 中文网关提示
    "超过",
    "限流",
    "配额",
    "频繁",
    "稍后",
    "请下一个周期",
  ];
  return patterns.some((p) => haystack.includes(p));
}

interface RuntimeErrorInfo {
  source: "model_gateway" | "runtime";
  retryable: boolean;
  statusCode?: number;
  message: string;
}

/** 给业务层稳定的错误语义：来源、是否适合自动重试、可读原因。 */
function classifyRuntimeError(error: unknown): RuntimeErrorInfo {
  const raw = errorDetails(error);
  const message = describeError(raw === error || !raw.message && !raw.responseBody ? error : raw);
  const haystack = `${message} ${raw.message ?? ""} ${raw.responseBody ?? ""}`.toLowerCase();
  const retryable = isRetryableError(haystack, raw.statusCode);
  return {
    source: raw.statusCode || raw.responseBody ? "model_gateway" : "runtime",
    retryable,
    ...(raw.statusCode ? { statusCode: raw.statusCode } : {}),
    message,
  };
}

/** SDK 常把 APICallError 包在 cause 里；向下找最有诊断价值的一层。 */
function errorDetails(error: unknown): {
    statusCode?: number;
    message?: string;
    responseBody?: string;
    cause?: unknown;
  } {
  let current = error;
  let fallback: ReturnType<typeof errorDetails> = {};
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const detail = current as ReturnType<typeof errorDetails>;
    fallback = detail;
    if (detail.statusCode || detail.responseBody) return detail;
    current = detail.cause;
  }
  return fallback;
}
