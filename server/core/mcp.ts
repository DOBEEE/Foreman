import fs from "node:fs";
import path from "node:path";
import type { McpServerMap } from "../types/agent-options.js";
import { configDir } from "../config/paths.js";
import { config } from "../config/index.js";

type ServerMap = McpServerMap;

/**
 * 从 server/config/mcp.servers.json 加载 MCP 服务声明。
 * SDK 会在 query() 时自动拉起 stdio 进程 / 连接远程 sse、http 服务，
 * 其工具以 mcp__<name>__<tool> 形式暴露给 agent。
 *
 * 文件分两段：
 * - mcpServers：全局，所有 agent 默认挂载
 * - optionalServers：按需，只有在岗位配置的 mcpServers 里点名才挂载（避免拖慢全体冷启动）
 *
 * 来源两份合并（用户覆盖内置）：
 * - 内置 server/config/mcp.servers.json：保留给「与内置岗位代码耦合」的 server，当前为空可缺省
 * - 用户 ~/.foreman/mcp.servers.json：出厂预置（presets/mcp.servers.json 播种）+ 用户自装
 *
 * 支持三种声明：
 *   stdio: { "type": "stdio", "command": "npx", "args": [...], "env": {} }
 *   sse:   { "type": "sse", "url": "https://...", "headers": {} }
 *   http:  { "type": "http", "url": "https://...", "headers": {} }
 */
interface McpFile {
  mcpServers?: ServerMap;
  optionalServers?: ServerMap;
}

function readOne(file: string): McpFile {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    console.warn(`[mcp] 解析 ${file} 失败，已忽略该文件:`, error);
    return {};
  }
}

/** ${VAR} 占位替换；有占位但环境变量缺失时返回 undefined（调用方丢弃整条声明） */
function expandEnv<T>(value: T): T | undefined {
  if (typeof value === "string") {
    let missing = false;
    const out = value.replace(/\$\{(\w+)\}/g, (_m, name: string) => {
      const v = process.env[name];
      if (!v) missing = true;
      return v ?? "";
    });
    return missing ? undefined : (out as unknown as T);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const next = expandEnv(item);
      if (next === undefined) return undefined;
      out.push(next);
    }
    return out as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const next = expandEnv(v);
      if (next === undefined) return undefined;
      out[k] = next;
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * 展开一段 server 声明里的 ${VAR}。缺凭据的 server 直接剔除——
 * 挂一个没有 API key 的 server 只会让 agent 白跑一轮再报错。
 */
function expandServers(map: ServerMap | undefined): { servers: ServerMap; skipped: string[] } {
  const servers: ServerMap = {};
  const skipped: string[] = [];
  for (const [name, decl] of Object.entries(map ?? {})) {
    const expanded = expandEnv(decl);
    if (expanded === undefined) skipped.push(name);
    else servers[name] = expanded;
  }
  return { servers, skipped };
}

/** 内置声明文件路径。内置项不可通过后台修改——只能改这个文件 */
export function builtinMcpFile(): string {
  return process.env.MCP_CONFIG_FILE
    ? path.resolve(process.env.MCP_CONFIG_FILE)
    : path.join(configDir, "mcp.servers.json");
}

function readMcpFile(): McpFile & { skipped: string[] } {
  const builtin = readOne(builtinMcpFile());
  const user = readOne(config.userMcpFile);
  const global = expandServers({ ...builtin.mcpServers, ...user.mcpServers });
  const optional = expandServers({ ...builtin.optionalServers, ...user.optionalServers });
  return {
    mcpServers: global.servers,
    optionalServers: optional.servers,
    skipped: [...global.skipped, ...optional.skipped],
  };
}

/** 全局 MCP（所有 agent 可用） */
export function loadMcpServers(): McpServerMap {
  return readMcpFile().mcpServers ?? {};
}

/** 按名挑选按需 MCP；名字不存在时告警并跳过 */
export function pickOptionalServers(names?: string[]): ServerMap {
  if (!names?.length) return {};
  const { optionalServers, skipped } = readMcpFile();
  const optional = optionalServers ?? {};
  const out: ServerMap = {};
  for (const name of names) {
    const server = optional[name];
    if (server) out[name] = server;
    else if (skipped.includes(name))
      console.warn(`[mcp] "${name}" 缺少所需凭据（.env 里的 \${…} 环境变量未设置），本次未挂载`);
    else console.warn(`[mcp] 未在 optionalServers 里找到 "${name}"，已跳过`);
  }
  return out;
}

/** 可选 MCP 的名字清单（招聘时给 HR 参考） */
export function listOptionalServerNames(): string[] {
  return Object.keys(readMcpFile().optionalServers ?? {});
}

/** 收集声明里所有 ${VAR} 占位中、当前环境缺失的变量名 */
function collectMissingEnv(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(/\$\{(\w+)\}/g)) {
      if (!process.env[m[1]]) out.add(m[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMissingEnv(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectMissingEnv(v, out);
  }
}

export interface McpServerEntry {
  name: string;
  /** global = 全员默认挂载；optional = 岗位点名才挂 */
  scope: "global" | "optional";
  /** builtin 的不可通过后台改（改 server/config/mcp.servers.json） */
  source: "builtin" | "user";
  /** **未展开**的原始声明——界面要能看到 ${VAR} 占位本身 */
  decl: Record<string, unknown>;
  /** 声明里引用了但当前环境没有的变量名。非空 = 这个 server 实际不会被挂载 */
  missingEnv: string[];
}

/**
 * 逐条列出 MCP server（后台管理用）。
 *
 * 与 loadMcpServers 的区别：这里**不做 ${VAR} 展开**，而是把缺失的变量名单独列出来。
 * 因为缺凭据的 server 在运行时是**静默剔除**的（挂一个没 key 的 server 只会让 agent
 * 白跑一轮再报错），界面上必须把这种「配了但根本没生效」显式标出来。
 */
export function listMcpServers(): McpServerEntry[] {
  const builtin = readOne(builtinMcpFile());
  const user = readOne(config.userMcpFile);
  const out: McpServerEntry[] = [];
  const sections = [
    { scope: "global" as const, key: "mcpServers" as const },
    { scope: "optional" as const, key: "optionalServers" as const },
  ];
  for (const { scope, key } of sections) {
    // 用户同名条目覆盖内置（与 readMcpFile 的合并顺序一致），所以 source 以用户侧为准
    const merged = { ...builtin[key], ...user[key] };
    for (const [name, decl] of Object.entries(merged)) {
      const missing = new Set<string>();
      collectMissingEnv(decl, missing);
      out.push({
        name,
        scope,
        source: user[key]?.[name] !== undefined ? "user" : "builtin",
        decl: decl as Record<string, unknown>,
        missingEnv: [...missing].sort(),
      });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
