import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import type { AgentProfile } from "../config/agent-profile.js";
import { listBuiltinProfiles, listHiredProfiles } from "../config/agent-profile.js";
import { config } from "../config/index.js";
import { listProviders, getProviderSecret } from "../config/providers-store.js";
import { listSkills, readSkillBody } from "../core/skill-store.js";
import { listMcpServers } from "../core/mcp.js";
import { loadBossPersona } from "../boss/persona.js";
import { teamBundleEnvelopeSchema } from "./schema.js";
import {
  TEAM_BUNDLE_FORMAT,
  TEAM_BUNDLE_VERSION,
  type PortableAgent,
  type PortableMcp,
  type PortableSkill,
  type TeamBundleEnvelope,
  type TeamBundlePayload,
} from "./types.js";

const MAX_COMPRESSED_BYTES = 5 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

export interface TeamExportOptions {
  name?: string;
  description?: string;
  kind?: "full" | "employees" | "custom";
  agentIds?: string[];
  includeBoss?: boolean;
  includeSkills?: boolean;
  includeMcps?: boolean;
  includeDependencies?: boolean;
}

export interface TeamExportResult {
  envelope: TeamBundleEnvelope;
  bytes: Buffer;
  filename: string;
  summary: {
    agents: number;
    skills: number;
    mcps: number;
    warnings: string[];
    /** 会原样写进包里的 MCP 字面量（公开常量），导出前需逐条给用户过目 */
    carriedLiterals: CarriedLiteral[];
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function packageVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(`${config.serviceRoot}/package.json`, "utf-8")) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function safeFilename(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, "-").slice(0, 80);
  return `${clean || "team"}.ait-team`;
}

function knownSecrets(): string[] {
  return listProviders()
    .map((p) => getProviderSecret(p.id))
    .filter((v): v is string => Boolean(v && v.length >= 8));
}

function redactText(raw: string, warnings: Set<string>): string {
  let out = raw;
  const roots: Array<[string, string]> = [
    [config.runtimeDir, "${runtimeDir}"],
    [config.serviceRoot, "${serviceRoot}"],
    [config.workingDir, "${workingDir}"],
    [config.knowledgeDir, "${knowledgeDir}"],
    [homedir(), "${homeDir}"],
  ];
  for (const [path, token] of roots.sort((a, b) => b[0].length - a[0].length)) {
    if (path && out.includes(path)) {
      out = out.split(path).join(token);
      warnings.add("已把正文中的本机路径替换为可移植占位符");
    }
  }
  for (const value of knownSecrets()) {
    if (out.includes(value)) {
      out = out.split(value).join("[REDACTED_SECRET]");
      warnings.add("正文中发现本机模型凭据，已脱敏");
    }
  }
  const credentialPatterns: Array<[RegExp, (...args: string[]) => string]> = [
    [/\bsk-[A-Za-z0-9_-]{16,}\b/g, () => "[REDACTED_SECRET]"],
    [/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, (_match, prefix) => `${prefix}[REDACTED_SECRET]`],
    [
      /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}["']?/gi,
      (_match, key) => `${key}=[REDACTED_SECRET]`,
    ],
  ];
  for (const [pattern, replacement] of credentialPatterns) {
    if (pattern.test(out)) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, replacement);
      warnings.add("正文中发现疑似凭据，已脱敏");
    }
    pattern.lastIndex = 0;
  }
  return out;
}

function safeAvatar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^https?:\/\//i.test(value)) return value.slice(0, 20);
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Agent 使用显式白名单构造，模型和本机字段没有进入对象的机会。 */
function portableAgent(profile: AgentProfile, warnings: Set<string>): PortableAgent {
  const text = (v: string | undefined) => (v ? redactText(v, warnings) : undefined);
  const portableRoots = profile.readRoots?.filter((r) => /^\$\{(?:codeRoots|knowledgeDir|workingDir)\}$/.test(r));
  if (profile.readRoots?.length && portableRoots?.length !== profile.readRoots.length) {
    warnings.add(`员工 ${profile.id} 的本机 readRoots 未导出，导入后需重新确认访问范围`);
  }
  if (profile.workspace && profile.workspace !== "auto") {
    warnings.add(`员工 ${profile.id} 的 workspace 未导出，导入后使用接收方默认工作目录`);
  }
  return {
    id: profile.id,
    ...(profile.displayName ? { displayName: text(profile.displayName) } : {}),
    ...(safeAvatar(profile.avatar) ? { avatar: safeAvatar(profile.avatar) } : {}),
    ...(profile.description ? { description: text(profile.description) } : {}),
    ...(profile.routeHint ? { routeHint: text(profile.routeHint) } : {}),
    type: profile.type === "sop" ? "sop" : "simple",
    ...(profile.systemPrompt ? { systemPrompt: redactText(profile.systemPrompt, warnings) } : {}),
    ...(profile.steps
      ? {
          steps: profile.steps.map((s) => ({
            ...s,
            prompt: redactText(s.prompt, warnings),
            ...(s.accept ? { accept: redactText(s.accept, warnings) } : {}),
          })),
        }
      : {}),
    ...(profile.tools ? { tools: [...profile.tools] } : {}),
    ...(profile.mcpServers ? { mcpServers: [...profile.mcpServers] } : {}),
    ...(profile.skills ? { skills: [...profile.skills] } : {}),
    ...(profile.workspacePolicy ? { workspacePolicy: profile.workspacePolicy } : {}),
    // 必须跟 workspacePolicy 一起导：只导一半会让对端拿到「maxParallel>1 但目录共享」的非法配置
    ...(profile.maxParallel != null ? { maxParallel: profile.maxParallel } : {}),
    ...(profile.reviewer ? { reviewer: profile.reviewer } : {}),
    ...(profile.retro ? { retro: structuredClone(profile.retro) } : {}),
    ...(profile.routeFallback != null ? { routeFallback: profile.routeFallback } : {}),
    ...(profile.manualOnly != null ? { manualOnly: profile.manualOnly } : {}),
    ...(profile.stream != null ? { stream: profile.stream } : {}),
    ...(profile.paramsSchema ? { paramsSchema: { ...profile.paramsSchema } } : {}),
  };
}

function bindingName(mcp: string, key: string): string {
  return `AIT_MCP_${mcp}_${key}`.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 128);
}

function exactPlaceholder(value: string): string | undefined {
  return value.match(/^\$\{([A-Z][A-Z0-9_]{1,127})\}$/)?.[1];
}

/**
 * 键名本身就说明这是凭据。**先看键名再看值**：`Authorization: "abc"` 这种短得不像密钥的
 * 值，靠值的形态永远判不出来，但键名是确定的。
 */
const CREDENTIAL_KEY_RE = /(authorization|auth|token|api[_-]?key|apikey|secret|password|passwd|cookie|session|credential|bearer|signature|access[_-]?key)/i;

/** Shannon 熵（bit/字符）：随机密钥远高于英文单词或路径 */
function shannonEntropy(value: string): number {
  if (!value) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * 看起来像随机密钥：够长、没有空白、字母数字混杂、熵够高。
 * 拦的是「无前缀的 32 位 hex / base64 token」这类不命中任何已知模式的裸密钥。
 */
function looksLikeRandomToken(value: string): boolean {
  if (value.length < 20 || /\s/.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  // 纯路径、URL、逗号分隔的枚举值不算（它们也可能长且混杂）
  if (/^[.~/]|^[a-z]+:\/\//i.test(value) || value.includes(",")) return false;
  return shannonEntropy(value) >= 3.2;
}

/**
 * 这个 MCP 字段值该不该当凭据处理（→ 只导出占位绑定、不带值）。
 *
 * **为什么是分级判定而不是一律当凭据**：一律当凭据（改之前的行为）在安全上是对的，
 * 但把 `NODE_ENV=production`、公共 baseUrl 这类公开常量也变成「待配置」，
 * 导入方每个这类 MCP 都要手填一遍才能启用，依赖它的员工在那之前一直被停用。
 *
 * **为什么这四道判据够**：`${VAR}` 是本仓库既有的凭据契约（`core/mcp.ts:42 expandEnv`
 * 就是「从 .env 取，取不到整条丢弃」），键名判据覆盖值形态看不出来的情况，
 * 已知凭据/前缀模式覆盖用户把密钥写成字面量的常见形态，高熵判据兜底裸随机串。
 *
 * **残余风险与安全网**：仍可能有既不命中键名、也不像随机串的真密钥（比如一个短口令）。
 * 所以字面量放行**必须**配 `carriedLiterals`——导出前把每一个原样带出的值列给用户看。
 * 判据再多也是启发式，而「导出前当着用户列出来」是确定性的。
 */
export function classifyMcpValue(
  key: string,
  value: string,
  knownSecretValues: string[] = [],
): { credential: boolean; reason?: "placeholder" | "key-name" | "known-secret" | "pattern" | "entropy" } {
  if (exactPlaceholder(value) || /\$\{[A-Z][A-Z0-9_]{1,127}\}/.test(value)) {
    return { credential: true, reason: "placeholder" };
  }
  if (CREDENTIAL_KEY_RE.test(key)) return { credential: true, reason: "key-name" };
  if (knownSecretValues.some((s) => value.includes(s))) {
    return { credential: true, reason: "known-secret" };
  }
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(value) || /\bBearer\s+\S{12,}/i.test(value)) {
    return { credential: true, reason: "pattern" };
  }
  if (looksLikeRandomToken(value)) return { credential: true, reason: "entropy" };
  return { credential: false };
}

/** 将原样写进团队包的字面量：导出前要逐条列给用户过目（见 classifyMcpValue 的安全网说明） */
export interface CarriedLiteral {
  mcp: string;
  target: "env" | "header" | "url" | "arg" | "command";
  key: string;
  value: string;
}

function portableMcp(
  entry: ReturnType<typeof listMcpServers>[number],
  warnings: Set<string>,
  literals: CarriedLiteral[] = [],
): PortableMcp {
  const source = entry.decl as PortableMcp["decl"];
  const bindings: PortableMcp["requiredBindings"] = [];
  const secretValues = knownSecrets();
  const bind = (
    raw: string,
    target: "env" | "header" | "command" | "arg" | "url",
    key: string,
    kind: "secret" | "path" = "secret",
    index?: number,
  ): string => {
    const existing = exactPlaceholder(raw);
    const placeholder = existing ?? bindingName(entry.name, key);
    bindings.push({ placeholder, kind, target, ...(target === "env" || target === "header" || target === "url" ? { key } : {}), ...(index != null ? { index } : {}) });
    return `\${${placeholder}}`;
  };

  /**
   * 凭据 → 占位绑定；公开常量 → 原样带走并记进 literals。
   * 用户把密钥写成字面量时要明确提示改用 `${VAR}`：这次导出虽然拦住了，
   * 但那个值仍以明文躺在本机 mcp.servers.json 里（那个文件不是 0600）。
   */
  const carry = (
    raw: string,
    target: "env" | "header" | "url",
    key: string,
  ): string => {
    const verdict = classifyMcpValue(key, raw, secretValues);
    if (!verdict.credential) {
      literals.push({ mcp: entry.name, target, key, value: raw });
      return raw;
    }
    if (verdict.reason && verdict.reason !== "placeholder") {
      warnings.add(
        `MCP ${entry.name} 的 ${target}.${key} 是写成字面量的凭据（判据：${verdict.reason}），导出时已转为占位绑定；建议本机也改成 \${VAR} 从 .env 取`,
      );
    }
    return bind(raw, target, key);
  };

  const decl: PortableMcp["decl"] = { type: source.type };
  if (source.type === "stdio") {
    const command = source.command ?? "";
    decl.command = isAbsolute(command)
      ? bind(command, "command", "COMMAND", "path")
      : command;
    if (source.args) {
      decl.args = source.args.map((arg, index) =>
        isAbsolute(arg)
          ? bind(arg, "arg", `ARG_${index}`, "path", index)
          : /(?:token|api[_-]?key|secret|password|authorization)/i.test(arg)
            ? bind(arg, "arg", `ARG_${index}`, "secret", index)
            : redactText(arg, warnings),
      );
    }
    if (source.env) {
      decl.env = Object.fromEntries(
        Object.entries(source.env).map(([key, value]) => [key, carry(value, "env", key)]),
      );
    }
  } else {
    const rawUrl = source.url ?? "";
    try {
      const url = new URL(rawUrl);
      if (url.username || url.password) {
        url.username = "";
        url.password = "";
        warnings.add(`MCP ${entry.name} 的 URL 用户信息已移除`);
      }
      for (const key of [...url.searchParams.keys()]) {
        url.searchParams.set(key, carry(url.searchParams.get(key) ?? "", "url", key));
      }
      url.hash = "";
      // URLSearchParams 会把 ${VAR} percent-encode；运行时的 expandEnv 只认识字面占位符，
      // 所以序列化后还原，否则导入后会把 "%24%7B..." 当普通字符串直接发出去。
      decl.url = url
        .toString()
        .replace(/%24%7B([A-Z][A-Z0-9_]{1,127})%7D/gi, (_m, name: string) => `\${${name}}`);
    } catch {
      decl.url = bind(rawUrl, "url", "URL", "secret");
    }
    if (source.headers) {
      decl.headers = Object.fromEntries(
        Object.entries(source.headers).map(([key, value]) => [key, carry(value, "header", key)]),
      );
    }
  }
  const unique = new Map(bindings.map((b) => [b.placeholder, b]));
  return { name: entry.name, scope: entry.scope, decl, requiredBindings: [...unique.values()] };
}

function employeeClosure(initial: string[], profiles: Map<string, AgentProfile>): string[] {
  const selected = new Set(initial);
  const queue = [...initial];
  while (queue.length) {
    const profile = profiles.get(queue.shift()!);
    if (profile?.reviewer && profiles.has(profile.reviewer) && !selected.has(profile.reviewer)) {
      selected.add(profile.reviewer);
      queue.push(profile.reviewer);
    }
    for (const step of profile?.steps ?? []) {
      for (const id of [step.delegate, step.reviewer]) {
        if (id && profiles.has(id) && !selected.has(id)) {
          selected.add(id);
          queue.push(id);
        }
      }
    }
  }
  return [...selected];
}

export function exportTeamBundle(options: TeamExportOptions = {}): TeamExportResult {
  const warnings = new Set<string>();
  const hired = listHiredProfiles();
  const hiredById = new Map(hired.map((p) => [p.id, p]));
  const kind = options.kind ?? (options.agentIds?.length ? "employees" : "full");
  const requested = options.agentIds?.length ? options.agentIds : hired.map((p) => p.id);
  const unknown = requested.filter((id) => !hiredById.has(id));
  if (unknown.length) throw new Error(`没有这些可分享员工：${unknown.join(", ")}`);
  const selectedIds = options.includeDependencies === false
    ? requested
    : employeeClosure(requested, hiredById);
  const selected = selectedIds.map((id) => hiredById.get(id)!);
  const includeBoss = options.includeBoss ?? kind === "full";
  const includeSkills = options.includeSkills ?? true;
  const includeMcps = options.includeMcps ?? true;

  const skills = listSkills();
  const userSkills = new Map(skills.filter((s) => s.source === "user").map((s) => [s.name, s]));
  const builtinSkills = new Set(skills.filter((s) => s.source === "builtin").map((s) => s.name));
  const skillNames = new Set<string>();
  for (const profile of selected) {
    for (const ref of profile.skills ?? []) skillNames.add(ref.replace(/^(?:user|builtin):/, ""));
  }
  if (kind === "full") for (const name of userSkills.keys()) skillNames.add(name);
  const portableSkills: PortableSkill[] = [];
  const builtinSkillRefs = new Set<string>();
  if (includeSkills) {
    for (const name of [...skillNames].sort()) {
      const skill = userSkills.get(name);
      if (skill) {
        const raw = readSkillBody(skill.ref);
        if (raw) portableSkills.push({ name, description: skill.description, raw: redactText(raw, warnings) });
      } else if (builtinSkills.has(name)) builtinSkillRefs.add(name);
      else warnings.add(`员工引用的 Skill ${name} 在本机不存在，未打包`);
    }
  }

  const allMcp = listMcpServers();
  const userMcp = new Map(allMcp.filter((m) => m.source === "user").map((m) => [m.name, m]));
  const builtinMcp = new Set(allMcp.filter((m) => m.source === "builtin").map((m) => m.name));
  const mcpNames = new Set<string>();
  for (const entry of allMcp) if (entry.scope === "global") mcpNames.add(entry.name);
  for (const profile of selected) {
    for (const name of profile.mcpServers ?? []) mcpNames.add(name);
    for (const tool of profile.tools ?? []) {
      const name = tool.match(/^mcp__([^_]+(?:[_-][^_]+)*)/)?.[1];
      if (name) mcpNames.add(name);
    }
  }
  if (kind === "full") for (const name of userMcp.keys()) mcpNames.add(name);
  const portableMcps: PortableMcp[] = [];
  const builtinMcpRefs = new Set<string>();
  const carriedLiterals: CarriedLiteral[] = [];
  if (includeMcps) {
    for (const name of [...mcpNames].sort()) {
      const entry = userMcp.get(name);
      if (entry) portableMcps.push(portableMcp(entry, warnings, carriedLiterals));
      else if (builtinMcp.has(name)) builtinMcpRefs.add(name);
      else warnings.add(`员工引用的 MCP ${name} 在本机不存在，未打包`);
    }
  }

  const builtinAgentIds = new Set(listBuiltinProfiles().map((p) => p.id));
  const builtinAgentRefs = new Set<string>();
  for (const profile of selected) {
    if (profile.reviewer && builtinAgentIds.has(profile.reviewer)) builtinAgentRefs.add(profile.reviewer);
    for (const step of profile.steps ?? []) {
      for (const id of [step.delegate, step.reviewer]) {
        if (id && builtinAgentIds.has(id)) builtinAgentRefs.add(id);
      }
    }
  }

  const boss = includeBoss ? structuredClone(loadBossPersona()) : undefined;
  if (boss?.employees) {
    boss.employees = Object.fromEntries(
      Object.entries(boss.employees).filter(([id]) => selectedIds.includes(id) || builtinAgentIds.has(id)),
    );
  }
  if (boss) {
    boss.name = redactText(boss.name, warnings);
    boss.role = redactText(boss.role, warnings);
    boss.personality = redactText(boss.personality, warnings);
    boss.style = redactText(boss.style, warnings);
    if (boss.team) boss.team = redactText(boss.team, warnings);
    boss.avatar = safeAvatar(boss.avatar);
  }

  const payload: TeamBundlePayload = {
    meta: {
      id: randomUUID(),
      name: options.name?.trim() || `${loadBossPersona().name}的团队`,
      ...(options.description?.trim() ? { description: options.description.trim() } : {}),
      createdAt: new Date().toISOString(),
      ...(packageVersion() ? { sourceVersion: packageVersion() } : {}),
    },
    scope: {
      kind,
      includeBoss,
      ...(kind !== "full" ? { requestedAgents: [...requested] } : {}),
    },
    ...(boss ? { boss } : {}),
    agents: selected.map((p) => portableAgent(p, warnings)),
    skills: portableSkills,
    mcps: portableMcps,
    dependencies: {
      builtinAgents: [...builtinAgentRefs].sort(),
      builtinSkills: [...builtinSkillRefs].sort(),
      builtinMcps: [...builtinMcpRefs].sort(),
    },
    security: {
      excluded: [
        "models/providers",
        "tokens/keys/secrets",
        "workspace/readRoots/local paths",
        "channels",
        "sessions/tasks/logs/memory/notes/schedules",
        "temporary employees",
      ],
      warnings: [...warnings],
    },
  };
  const digest = sha256(JSON.stringify(payload));
  const envelope: TeamBundleEnvelope = {
    format: TEAM_BUNDLE_FORMAT,
    version: TEAM_BUNDLE_VERSION,
    payload,
    integrity: { algorithm: "sha256", digest },
  };
  teamBundleEnvelopeSchema.parse(envelope);
  const bytes = gzipSync(Buffer.from(JSON.stringify(envelope), "utf-8"), { level: 9 });
  return {
    envelope,
    bytes,
    filename: safeFilename(payload.meta.name),
    summary: {
      agents: payload.agents.length,
      skills: payload.skills.length,
      mcps: payload.mcps.length,
      warnings: payload.security.warnings,
      // 分级判定放行的字面量必须逐条回给调用方——启发式判据再多都可能漏，
      // 「导出前当着用户列出来」才是确定性的那道防线
      carriedLiterals,
    },
  };
}

export function parseTeamBundle(bytes: Buffer): TeamBundleEnvelope {
  if (bytes.length === 0) throw new Error("团队包为空");
  if (bytes.length > MAX_COMPRESSED_BYTES) throw new Error("团队包超过 5MB 限制");
  let decoded: Buffer;
  try {
    decoded = gunzipSync(bytes, { maxOutputLength: MAX_PAYLOAD_BYTES });
  } catch (error) {
    throw new Error(`不是合法的 .ait-team 文件：${error instanceof Error ? error.message : error}`);
  }
  if (decoded.length > MAX_PAYLOAD_BYTES) throw new Error("团队包解压后超过 20MB 限制");
  let raw: unknown;
  try {
    raw = JSON.parse(decoded.toString("utf-8"));
  } catch {
    throw new Error("团队包内容不是合法 JSON");
  }
  const parsed = teamBundleEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`团队包协议校验失败：${parsed.error.issues[0]?.message ?? "未知错误"}`);
  const actual = sha256(JSON.stringify(parsed.data.payload));
  if (actual !== parsed.data.integrity.digest) throw new Error("团队包完整性校验失败，文件可能已损坏或被修改");
  return parsed.data as TeamBundleEnvelope;
}
