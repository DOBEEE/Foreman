import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ToolGuard } from "../runtime/hooks.js";
import { LOG_DIR } from "./logger.js";
import { MEMORY_ROOT } from "./memory.js";
import { isNotesPath, isOwnNotesPath, notesDirOf } from "./notes.js";

/**
 * 工具调用门禁总集（审计 + 各类范围限制）。
 *
 * 全部实现为 `ToolGuard`：在工具 execute 之前跑，deny 则不执行并把原因回给模型
 * （见 runtime/hooks.ts 的 applyGuards）。**不要**再写成 SDK hook 形状——
 * 本仓库的 runtime 是 Vercel AI SDK，hook 那套没有执行点，写了等于没写。
 */

const allow = { allow: true } as const;
function deny(agentName: string, tool: string, reason: string) {
  console.warn(`[${agentName}] blocked ${tool}: ${reason}`);
  return { deny: true as const, reason };
}

/** 审计归属：渠道 + 触发人（渠道层解析后随 params 传入） */
export interface AuditIdentity {
  channel?: string;
  senderId?: string;
  senderName?: string;
}

/**
 * 全局审计：所有 agent 的每次工具调用在执行前落一行审计日志。
 * logs/audit-<date>.jsonl：{ time, agent, channel, senderId, tool, input }
 * 只记录、从不拦截——审计失败也不能影响业务。
 */
export function buildAuditGuard(agent: string, identity?: AuditIdentity): ToolGuard {
  return async (toolName, input) => {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const record = {
        time: new Date().toISOString(),
        agent,
        ...(identity?.channel ? { channel: identity.channel } : {}),
        ...(identity?.senderId ? { senderId: identity.senderId } : {}),
        ...(identity?.senderName ? { senderName: identity.senderName } : {}),
        tool: toolName,
        input,
      };
      appendFileSync(join(LOG_DIR, `audit-${date}.jsonl`), `${JSON.stringify(record)}\n`);
    } catch {
      // 审计失败不阻塞执行
    }
    return allow;
  };
}

/** SDK 记忆目录特征：~/.claude/projects/<cwd 转义路径>/memory/ */
const MEMORY_PATH_PATTERN = /\/\.claude\/(projects\/[^/]+\/)?memory(\/|$)/;

/** 带边界的目录归属判定：裸 startsWith 会让 memory/lead 错误匹配 memory/leadership */
function withinDir(target: string, dir: string): boolean {
  const base = resolve(dir);
  const t = resolve(target);
  return t === base || t.startsWith(`${base}/`);
}

/** 项目内经验库目录（<runtimeDir>/memory），写入范围门禁用前缀判定 */
function isMemoryPath(p: string): boolean {
  return withinDir(p, MEMORY_ROOT);
}

/** 从工具入参里取出所有可能的路径字段 */
export function extractPaths(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const record = toolInput as Record<string, unknown>;
  return ["file_path", "path", "notebook_path"]
    .map((key) => record[key])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** 写类工具名（拦截写入用；读类不拦） */
export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * 这次调用「要写入的路径」：写类工具取路径字段，Bash 取命令里真正的写目标
 * （重定向目标、rm/tee/mv 等的目标参数），命令里的只读引用不算。
 *
 * 只认 Write/Edit 是不够的——只要岗位有 Bash，`cat > x`、`tee x`、`mv a x` 就是一道旁门。
 * 实测复盘员工正是用 `cat > memory/<别人>/index.md` 绕过经验库隔离、覆写了别人的记忆，
 * 而门禁一声没响。readRoots 门禁早就按这个思路管住了 Bash，经验库/笔记这两道漏了。
 */
export function writeTargetsOf(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return bashWriteTargets(command);
  }
  return WRITE_TOOLS.has(toolName) ? extractPaths(input) : [];
}

/**
 * 经验库写入范围：
 * - 常规运行（allowAgentName 未给）：memory 目录只读，任何写入 deny
 * - 复盘运行（allowAgentName=当前员工名）：仅放行写入该员工自己的 memory 子目录，
 *   写别的员工目录 deny（防止 A 的复盘污染 B 的记忆）
 */
export function buildMemoryScopeGuard(agentName: string, allowAgentName?: string): ToolGuard {
  const allowedDir = allowAgentName ? join(MEMORY_ROOT, allowAgentName) : undefined;
  return async (toolName, input) => {
    const hit = writeTargetsOf(toolName, input).find(isMemoryPath);
    if (!hit) return allow;
    if (allowedDir && withinDir(hit, allowedDir)) return allow;
    return deny(
      agentName,
      toolName,
      allowedDir
        ? `拒绝写入 ${hit}：本轮复盘只放行「${allowAgentName}」自己的经验库目录（${allowedDir}/），不得改动其他员工的记忆`
        : `拒绝写入 ${hit}：经验库（memory/）在常规运行时只读，仅复盘流程可写入`,
    );
  };
}

/**
 * 笔记写入范围：员工可以写**自己**的 notes/<id>/，但不能写别人的。
 * 与经验库门禁互补：笔记（原料）归员工自己写，记忆（资产）只归复盘员写。
 */
export function buildNotesScopeGuard(agentName: string): ToolGuard {
  return async (toolName, input) => {
    const hit = writeTargetsOf(toolName, input).find(isNotesPath);
    if (!hit || isOwnNotesPath(hit, agentName)) return allow;
    return deny(
      agentName,
      toolName,
      `拒绝写入 ${hit}：只能写自己的笔记目录（${notesDirOf(agentName)}/），不得改动其他员工的笔记`,
    );
  };
}

/**
 * 记忆读写拦截：MEMORY=off（serve 多租户默认）时，拒绝碰 SDK 记忆目录——
 * 多租户下记忆没有主人，写入即跨用户泄漏（cwd 共享，A 的信息会被 B 的会话读到）。
 */
export function buildMemoryOffGuard(agentName: string): ToolGuard {
  return async (toolName, input) => {
    const hit = extractPaths(input).find((p) => MEMORY_PATH_PATTERN.test(p));
    if (!hit) return allow;
    return deny(
      agentName,
      toolName,
      "本部署为多用户共享服务，记忆功能已禁用（跨用户隔离），请不要读写 memory 目录",
    );
  };
}

/** 受保护分支：禁止 push 到这些分支/引用 */
const PROTECTED_BRANCHES = ["master", "main", "develop", "release"];

/**
 * 判断一条 git push 命令是否指向受保护分支。
 * 覆盖常见写法：`git push origin master`、`git push origin HEAD:main`、
 * `git push origin coder/x master`（多 refspec）、`git push --force origin main`。
 * 保守策略：无法确定目标分支的 push（如裸 `git push` 依赖 upstream）也拦下，
 * 要求显式指定工作分支，避免误推当前恰好是主干的情况。
 */
export function isPushToProtected(command: string): boolean {
  const cmd = command.trim();
  // 仅拦 git push
  if (!/(^|[;&|]\s*)git\s+push\b/.test(cmd)) return false;

  // 取 push 子命令片段（到下一个命令分隔符为止）
  const seg = cmd.split(/[;&|]/).find((s) => /\bgit\s+push\b/.test(s)) ?? cmd;
  const tokens = seg.trim().split(/\s+/);
  // 去掉 git push 及选项(-x/--x)、remote 名，剩下的视为 refspec 候选
  const refs = tokens
    .slice(tokens.indexOf("push") + 1)
    .filter((t) => !t.startsWith("-"));
  // refs[0] 通常是 remote（origin），其余是 refspec；但也可能无 remote
  const refspecs = refs.slice(1).length > 0 ? refs.slice(1) : refs;

  // 无显式 refspec 的裸 push（git push / git push origin）→ 保守拦截
  if (refspecs.length === 0 || (refs.length === 1 && refspecs[0] === refs[0])) {
    if (refspecs.length === 0 || refspecs.every((r) => r === refs[0])) return true;
  }

  return refspecs.some((spec) => {
    // 取冒号后的目标端（src:dst），无冒号则整体即目标
    const dst = spec.includes(":") ? spec.split(":").pop()! : spec;
    const branch = dst.replace(/^refs\/heads\//, "");
    return PROTECTED_BRANCHES.includes(branch);
  });
}

/**
 * 主干保护：拦截 push 到 master/main 等受保护分支（含 --force）。
 * 允许 push 工作分支（如 feat/xxx）。push 是外部可见、难撤销的操作，
 * 需一道确定性防线，不能只靠提示词自觉。
 */
export function buildBranchGuard(agentName: string): ToolGuard {
  return async (toolName, input) => {
    if (toolName !== "Bash") return allow;
    const command = typeof input.command === "string" ? input.command : "";
    if (!isPushToProtected(command)) return allow;
    return deny(
      agentName,
      toolName,
      "禁止 push 到主干分支（master/main 等）。请 push 你的工作分支（如 feat/xxx），" +
        "合入主干走 MR/PR。裸 push 也被拦截，请显式指定工作分支。",
    );
  };
}

/**
 * 敏感路径黑名单：凭据 / 密钥 / 历史对话日志 / git 内部对象。
 * 启用只读根门禁的岗位（profile.readRoots）连白名单「内部」的这些文件也不许碰
 * （如被检索仓库自带的 .env）。
 */
export const SENSITIVE_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)logs(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.(ssh|aws|kube|claude)(\/|$)/,
  /(^|\/)(id_rsa|id_ed25519|\.npmrc|\.netrc)(\/|$)/,
  /\.(pem|key|p12|pfx|keystore)$/i,
];

/** 路径是否落在某个根内 */
function withinRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, target);
    return rel === "" || !rel.startsWith("..");
  });
}

/** Bash 命令串里出现的绝对路径与 ~ 路径（粗粒度提取，用于给 Bash 也上一道范围门禁） */
function pathsInCommand(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|[\s'"=(<>|&;])((?:~|\/)[^\s'"`)|&;]*)/g)) {
    const raw = m[1];
    // 过滤掉 /dev/null、单个 / 之类无意义目标与命令自身（/usr/bin/xxx 这类可执行文件放行）
    if (raw === "/" || raw.startsWith("/dev/")) continue;
    out.push(raw.startsWith("~") ? raw.replace(/^~/, process.env.HOME ?? "~") : raw);
  }
  return out;
}

/** 落盘 / 破坏性命令：其路径参数是写目标 */
const WRITE_CMDS = new Set([
  "rm",
  "mv",
  "cp",
  "tee",
  "dd",
  "chmod",
  "chown",
  "truncate",
  "mkdir",
  "touch",
  "ln",
]);

/** 这些命令只有**末尾**参数是写目标，前面的是来源（`cp 检索源 工作目录` 的来源仍是只读） */
const DEST_ONLY_CMDS = new Set(["cp", "mv", "ln"]);

/** 不落任何文件的重定向目标：算成写入会把只读命令的惯用写法判成越界写 */
const NULL_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** 命令分隔符：写目标的作用范围到此为止 */
const SEGMENT_OPS = new Set([";", "|", "||", "&", "&&", "(", ")", "\n"]);

type BashToken = { text: string; op: boolean };

/**
 * Bash 命令分词：引号内的内容按字面值取出，引号外的操作符单独成词。
 *
 * 必须自己分词而不是拿正则扫——写目标是「操作符后面那个词」，正则拿不到这层结构，
 * 而结构恰恰是区分「写目标」和「只读引用」的唯一依据。引号处理不能省：
 * `awk 'NR>1'` 里的 `>` 与重定向同形，`> "有空格的路径"` 的目标也只能从引号里取。
 */
function tokenizeBash(command: string): BashToken[] {
  const tokens: BashToken[] = [];
  let buf = "";
  let quoted = false;
  let quote: '"' | "'" | undefined;
  const flush = () => {
    if (buf || quoted) tokens.push({ text: buf, op: false });
    buf = "";
    quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      buf += command[++i];
      continue;
    }
    if (ch === "\n") {
      flush();
      tokens.push({ text: "\n", op: true });
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (/[<>;|&()]/.test(ch)) {
      flush();
      let op = ch;
      while (i + 1 < command.length && /[<>;|&]/.test(command[i + 1]!)) op += command[++i]!;
      tokens.push({ text: op, op: true });
      continue;
    }
    buf += ch;
  }
  flush();
  return tokens;
}

/**
 * 写重定向操作符：`>`、`>>`、`>|`、`&>`、`&>>`。
 * `>&`（`2>&1` 这类复制描述符）不写文件，`<`/`<<` 是读，都不算。
 */
function isWriteRedirect(op: string): boolean {
  return /^&?>{1,2}\|?$/.test(op);
}

/**
 * 这条 Bash 命令真正要写的路径。
 *
 * **只认写目标，不认命令里出现的其它路径**——这是本函数存在的全部意义。早先的实现是
 * 「命令含任一写迹象 → 命令里所有路径都按 writeRoots 校验」，于是
 * `bash <只读的技能脚本> > 工作目录/out.txt` 被判成「拒绝写入该脚本」：脚本只是被执行，
 * 输出才落盘，且落在放行范围里。实测这道误判连挡三次，把一个员工的整轮预算耗在
 * 跟门禁较劲上，且拒绝文案指向的还是无辜路径，模型据此判断门禁坏了。
 *
 * 返回值可能是相对路径（`> raw/out.txt`），由调用方按本次 run 的 cwd 解析——
 * 这样 `> ../../越界` 也能被抓到。
 */
function bashWriteTargets(command: string): string[] {
  const tokens = tokenizeBash(command);
  const targets: string[] = [];
  const push = (raw: string) => {
    if (!raw || raw === "/" || NULL_SINKS.has(raw)) return;
    targets.push(raw.startsWith("~") ? raw.replace(/^~/, process.env.HOME ?? "~") : raw);
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    // ① 写重定向：紧随其后的词就是目标
    if (tok.op && isWriteRedirect(tok.text)) {
      const next = tokens[i + 1];
      if (next && !next.op) push(next.text);
      continue;
    }
    if (tok.op || !WRITE_CMDS.has(tok.text)) continue;
    // ② 落盘 / 破坏性命令：收集本段内的路径参数（选项与操作符不算）
    const args: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const arg = tokens[j]!;
      if (arg.op) {
        if (SEGMENT_OPS.has(arg.text)) break;
        // 段内的重定向留给 ① 处理，跳过它和它的目标
        if (isWriteRedirect(arg.text) || /^&?<{1,2}/.test(arg.text)) j++;
        continue;
      }
      if (arg.text.startsWith("-")) continue;
      args.push(arg.text);
    }
    if (tok.text === "dd") {
      for (const arg of args) if (arg.startsWith("of=")) push(arg.slice(3));
      continue;
    }
    if (DEST_ONLY_CMDS.has(tok.text)) {
      if (args.length) push(args[args.length - 1]!);
      continue;
    }
    for (const arg of args) push(arg);
  }
  return targets;
}

/**
 * 文件访问门禁（profile.readRoots 声明即启用，对所有 agent 通用机制）：
 * 带路径的工具入参逐一校验——越出 roots（含本次 run cwd）或命中敏感名单直接 deny。
 *
 * **读写分离**：readRoots 是「能看」的范围（知识库、代码仓库等检索源），
 * writeRoots 是「能改」的范围（自己的工作目录、自己的笔记目录）。
 * 两者分开的原因：检索源必须严格只读——否则只读岗位一旦拿到 Write 工具，
 * 就能覆写知识库文件，把答疑的事实源污染掉。
 *
 * **Bash 的覆盖是不对称的**，这是刻意的：
 * - 命令里**真正的写目标**（重定向目标 / rm / mv / tee … 的目标参数）→ 按 writeRoots 校验。
 *   给了 Bash 又只拦 Write 工具，等于在围栏边上留了一道门。
 * - 命令里其余路径（被执行的脚本、被读的文件）→ 只查敏感名单，**不**做 roots 校验。
 *   否则 `node /usr/bin/x` 这类对系统路径的正常引用会被误杀，代价大于收益
 *   （能跑 Bash 的岗位本来就读得到）。**尤其不能因为同一条命令里有写动作，
 *   就把命令里的只读引用一并按 writeRoots 校验**——`bash <只读脚本> > 工作目录/out`
 *   会被判成「拒绝写入该脚本」，实测连挡三次、耗掉员工整轮预算。
 *
 * 已知边界：变量拼接抓不到。所以给 Bash 权限的岗位仍以
 * 「per-run 工作目录隔离 + tools 白名单」为主，本门禁只挡最常见的越界直写。
 */
export function buildReadRootsGuard(
  agentName: string,
  cwd: string,
  readRoots: string[],
  writeRoots: string[],
): ToolGuard {
  return async (toolName, input) => {
    const isBash = toolName === "Bash";
    const command = isBash && typeof input.command === "string" ? input.command : "";
    // Bash 只对写目标做 roots 校验；写类工具的路径字段本身就是写目标
    const writeTargets = isBash ? bashWriteTargets(command) : [];
    const isWrite = WRITE_TOOLS.has(toolName) || writeTargets.length > 0;
    const allowed = isWrite ? writeRoots : readRoots;
    const referenced = isBash ? pathsInCommand(command) : extractPaths(input);
    const rootsCandidates = isBash ? writeTargets : referenced;
    for (const raw of rootsCandidates) {
      if (withinRoots(resolve(cwd, raw), allowed)) continue;
      return deny(
        agentName,
        toolName,
        isWrite
          ? `拒绝写入 ${raw}：「${agentName}」只能写自己的工作目录与笔记目录（${allowed.join(" / ")}），检索源是只读的`
          : `拒绝访问 ${raw}：超出「${agentName}」的可访问范围（${allowed.join(" / ")}）`,
      );
    }
    for (const raw of new Set([...referenced, ...writeTargets])) {
      if (!SENSITIVE_PATTERNS.some((p) => p.test(resolve(cwd, raw)))) continue;
      return deny(
        agentName,
        toolName,
        `拒绝访问 ${raw}：凭据 / 密钥 / 历史日志类文件不在可访问范围内`,
      );
    }
    return allow;
  };
}

/**
 * MCP 工具范围：profile.tools 里声明的 `mcp__` 条目即白名单。
 *
 * 首选做法是**不注册未授权工具**（runtime 按同一套 patterns 过滤 mcpTools），
 * 模型看不见=不会调=省 token。本 guard 是第二道：万一注册侧漏了，调用时也拦下。
 *
 * 匹配规则：
 * - `mcp__server`（server 级）→ 放行该 server 下全部工具
 * - `mcp__server__tool`（工具级）→ 精确放行这一个
 */
export function buildMcpScopeGuard(agentName: string, patterns: string[]): ToolGuard {
  const { exact, prefixes } = splitMcpPatterns(patterns);
  return async (toolName) => {
    if (!toolName.startsWith("mcp__")) return allow;
    if (exact.has(toolName) || prefixes.some((p) => toolName.startsWith(p))) return allow;
    return deny(agentName, toolName, `不在「${agentName}」被授权的 MCP 工具范围内`);
  };
}

/** 拆分 MCP 白名单写法：server 级（两段）走前缀，工具级（三段）走精确 */
export function splitMcpPatterns(patterns: string[]): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const p of patterns) {
    if (p.split("__").length <= 2) prefixes.push(`${p}__`);
    else exact.add(p);
  }
  return { exact, prefixes };
}

/** 按白名单判断一个 MCP 工具名是否放行（runtime 注册期过滤用） */
export function mcpToolAllowed(
  name: string,
  scope: { exact: Set<string>; prefixes: string[] },
): boolean {
  if (!name.startsWith("mcp__")) return true;
  return scope.exact.has(name) || scope.prefixes.some((p) => name.startsWith(p));
}
