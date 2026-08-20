import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { getAgent, listAgents } from "../agents/registry.js";
import { loadAgentProfile } from "../config/agent-profile.js";
import { config, logDir } from "../config/index.js";
import { serviceRoot } from "../config/paths.js";
import { buildKnowledgeIndex } from "../core/knowledge.js";
import { loadMemory } from "../core/memory.js";
import { listSkills, readSkillBody } from "../core/skill-store.js";
import { collectRunWithTrace, type RunInput } from "../core/runner.js";

/**
 * Benchmark 专用端点：供外部评测工具（agent-bench）驱动单次员工执行并取回可判定的证据。
 *
 * 为什么单独一套而不复用 /api/agents/:name/run：
 * - 评测必须能指定工作目录（cwd），而把 cwd 开放给零鉴权的根级 API 等于任意目录写入；
 * - 评测必须能关掉经验库注入才可比（复盘每天改写它）；
 * - 评测需要一份 per-run 的 trace 文件，而 appendTraceLog 只按天聚合、runId 也不外流。
 *
 * 安全姿态：BENCH_TOKEN 未设置则整个 router 不注册（默认关闭）；
 * 注册后仍要求 Bearer token + 回环地址，**不放行同网段**——这个端点能让 agent 在本机任意路径读写。
 */

const BENCH_PROTOCOL = 1;

/** 评测协议固定的渠道上下文：会渲染进 systemPrompt，必须是常量否则两次跑 prompt 不同 */
const BENCH_PARAMS = {
  channel: "http",
  chatType: "private",
  senderName: "benchmark",
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isLoopback(raw: string): boolean {
  return raw === "127.0.0.1" || raw === "::1" || raw === "::ffff:127.0.0.1";
}

/** 服务代码版本：脏工作区也要体现，否则「跑的是旧 dist」无法察觉 */
let revisionCache: string | undefined;
function serviceRevision(): string {
  if (revisionCache) return revisionCache;
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: serviceRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const head = git(["rev-parse", "HEAD"]).trim();
    const diff = git(["diff", "HEAD"]) + git(["diff", "--cached"]);
    revisionCache = diff.trim() ? `git:${head}:dirty:${sha256(diff).slice(0, 16)}` : `git:${head}`;
  } catch {
    revisionCache = "unknown";
  }
  return revisionCache;
}

/**
 * 被测服务的运行期状态摘要，进 agent-bench 的 fingerprint。
 *
 * 存在的理由：suite 里只写 endpointEnv 的**变量名**，URL 值不进任何 fingerprint。
 * 没有这个 key，把 suite 从一个岗位指向另一个岗位、或服务没重启跑的还是旧代码，
 * 基线比较仍会判「可比」，门禁直接失效。
 */
function buildRuntimeState(): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  const memory: Record<string, string> = {};
  for (const { name } of listAgents()) {
    const agent = getAgent(name);
    if (!agent) continue;
    const profile = loadAgentProfile(name) ?? { id: name };
    agents[name] = {
      // 解析后的 profile（含用户 overlay 合并结果）：optimizer 改 systemPrompt 必须反映出来,
      // 这正是门禁要检测的那个变量
      profileHash: sha256(JSON.stringify(profile)),
      retroEnabled: Boolean(agent.retroSpec?.enabled),
    };
    // 用 loadMemory 的返回值而非目录哈希：它才是真正进 prompt 的内容,
    // 含「小库全量注入 / 大库只给索引」的阈值降级效果
    const injected = agent.retroSpec?.enabled ? loadMemory(name) : undefined;
    memory[name] = injected ? sha256(injected) : "empty";
  }

  const skillBodies = listSkills()
    .map((s) => `${s.ref}\n${readSkillBody(s.ref) ?? ""}`)
    .sort()
    .join("\n---\n");

  return {
    schemaVersion: 1,
    benchProtocol: BENCH_PROTOCOL,
    serviceRevision: serviceRevision(),
    agents,
    memory,
    skills: sha256(skillBodies),
    knowledgeIndex: sha256(buildKnowledgeIndex()),
    knowledgeRoot: config.knowledgeDir,
    // 注入已关闭，所以上面的 memory 摘要只是审计留痕；承担可比性的是这个字段
    memoryInjection: "off",
  };
}

interface BenchRunBody {
  caseId?: unknown;
  prompt?: unknown;
  workspace?: unknown;
  inputRoot?: unknown;
}

function badRequest(res: Response, error: string): void {
  res.status(400).json({ error });
}

async function handleBenchRun(req: Request, res: Response): Promise<void> {
  const agent = getAgent(req.params.name);
  if (!agent) {
    res.status(404).json({ error: `unknown agent "${req.params.name}"`, available: listAgents() });
    return;
  }

  const { caseId, prompt, workspace, inputRoot } = (req.body ?? {}) as BenchRunBody;
  if (typeof caseId !== "string" || !caseId.trim()) return badRequest(res, "caseId is required");
  if (typeof prompt !== "string" || !prompt.trim()) return badRequest(res, "prompt is required");
  if (typeof workspace !== "string" || !isAbsolute(workspace) || !existsSync(workspace)) {
    return badRequest(res, "workspace must be an existing absolute path");
  }
  if (typeof inputRoot !== "string" || !isAbsolute(inputRoot)) {
    return badRequest(res, "inputRoot must be an absolute path");
  }
  // 这里不做 needsSerialRun 拦截：那条判据针对的是「多个 run 共享同一工作目录会踩踏」，
  // 而评测每次都传入独立 workspace 作为 cwd，前提不成立。

  const benchRunId = randomUUID();
  const runDir = join(logDir, "bench", `${caseId.replace(/[^\w.-]/g, "_")}-${benchRunId.slice(0, 8)}`);
  mkdirSync(runDir, { recursive: true });

  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  const startedAt = new Date();
  const input: RunInput = {
    // 不过 resolveCommandPrompt：/xxx 会被展开成 playbook 正文，评测要的是原文入参
    prompt,
    cwd: workspace,
    memory: "off",
    // 绝不传 taskId / __internal：那会触发员工交卷协议或编队协议注入，等于换了一套被测提示词
    params: { ...BENCH_PARAMS, benchCaseId: caseId },
    abortController,
  };

  try {
    const { text, toolCalls, summary, lines } = await collectRunWithTrace(
      agent.run(input),
      startedAt.getTime(),
    );
    const traceFile = join(runDir, "trace.jsonl");
    writeFileSync(traceFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const answerFile = join(runDir, "answer.md");
    writeFileSync(answerFile, text);
    const recordFile = join(runDir, "trace-record.json");
    writeFileSync(
      recordFile,
      JSON.stringify({ benchRunId, caseId, agent: agent.name, prompt, summary, lines }, null, 2),
    );

    res.json({
      schemaVersion: 1,
      agent: agent.name,
      caseId,
      benchRunId,
      text,
      toolCalls,
      summary,
      // 只回 transcriptFile：transcriptRoot/transcriptManifest 是 AIT manifest 门禁的入口，
      // 这条链路走的是通用证据路径，返回它们只会把人引到错的分支上
      executionRecord: {
        executionId: benchRunId,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        transcriptFile: traceFile,
        artifacts: [answerFile, recordFile],
      },
      bench: { runDir, answerFile, knowledgeRoot: config.knowledgeDir, memory: "off" },
      targetState: buildRuntimeState(),
    });
  } catch (error) {
    // 走到这里说明没能产出 trace，评测侧应记为 failed 而不是「跑完但分低」
    res.status(500).json({
      agent: agent.name,
      caseId,
      benchRunId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 构造 bench router。BENCH_TOKEN 未设置返回 undefined —— 调用方据此跳过注册，
 * 保证默认不对外开放这条能指定任意 cwd 的通道。
 */
export function createBenchRouter(): express.Router | undefined {
  const token = process.env.BENCH_TOKEN;
  if (!token) return undefined;

  const router = express.Router();
  router.use((req: Request, res: Response, next: NextFunction) => {
    const provided = req.headers.authorization;
    if (provided !== `Bearer ${token}`) {
      res.status(401).json({ error: "invalid bench token" });
      return;
    }
    if (!isLoopback(req.socket.remoteAddress ?? "")) {
      res.status(403).json({ error: "bench endpoint 仅允许回环地址访问" });
      return;
    }
    next();
  });

  router.get("/state", (_req, res) => {
    res.json(buildRuntimeState());
  });
  router.get("/agents/:name/state", (req, res) => {
    const agent = getAgent(req.params.name);
    if (!agent) {
      res.status(404).json({ error: `unknown agent "${req.params.name}"` });
      return;
    }
    res.json(buildRuntimeState());
  });
  router.post("/agents/:name/run", (req, res) => {
    void handleBenchRun(req, res);
  });

  return router;
}
