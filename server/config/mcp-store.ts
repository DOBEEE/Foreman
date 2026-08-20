import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "./index.js";

/**
 * MCP server 的后台增删改（只写用户侧 <runtimeDir>/mcp.servers.json）。
 *
 * 内置侧 server/config/mcp.servers.json 由代码仓库管理、不从后台改——
 * 与 agent 的「内置岗位改 JSON 文件、招聘岗位走 dashboard」是同一套规矩。
 *
 * 文件结构与 core/mcp.ts 的读取端严格对应：
 *   { mcpServers: {...}, optionalServers: {...} }
 * mcpServers   = 全员默认挂载
 * optionalServers = 岗位在 profile.mcpServers 里点名才挂（避免拖慢全体冷启动）
 */

export type McpScope = "global" | "optional";

export interface McpServerDecl {
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerInput {
  name: string;
  scope: McpScope;
  decl: McpServerDecl;
}

interface McpFileShape {
  mcpServers?: Record<string, McpServerDecl>;
  optionalServers?: Record<string, McpServerDecl>;
}

/** server 名会被拼进工具名 `mcp__<name>__<tool>`，所以只许 slug */
const NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;

const SECTION: Record<McpScope, "mcpServers" | "optionalServers"> = {
  global: "mcpServers",
  optional: "optionalServers",
};

function readUserFile(): McpFileShape {
  const file = config.userMcpFile;
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as McpFileShape;
  } catch (error) {
    // 这里**必须抛**而不是回落空对象：静默当成空会让后续写入覆盖掉整份用户配置
    throw new Error(
      `${file} 不是合法 JSON，拒绝写入以免覆盖已有配置：${error instanceof Error ? error.message : error}`,
    );
  }
}

/** 原子写：写临时文件再 rename，避免半截文件被并发读到 */
function writeUserFile(data: McpFileShape): void {
  const file = config.userMcpFile;
  mkdirSync(config.runtimeDir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  renameSync(tmp, file);
}

export function validateMcpServer(input: Partial<McpServerInput>): string[] {
  const errs: string[] = [];
  if (typeof input.name !== "string" || !NAME_RE.test(input.name)) {
    errs.push("name 非法：需 1-40 位小写字母开头的 slug（字母/数字/-/_）——它会被拼进工具名 mcp__<name>__<tool>");
  }
  if (input.scope !== "global" && input.scope !== "optional") {
    errs.push("scope 只能是 global（全员挂载）或 optional（岗位点名才挂）");
  }
  const d = input.decl;
  if (!d || typeof d !== "object") {
    errs.push("decl 不能为空");
    return errs;
  }
  if (d.type !== "stdio" && d.type !== "sse" && d.type !== "http") {
    errs.push("type 只能是 stdio / sse / http");
  } else if (d.type === "stdio") {
    if (!d.command?.trim()) errs.push("stdio 类型必须填 command");
    if (d.args != null && !Array.isArray(d.args)) errs.push("args 必须是字符串数组");
  } else if (!d.url?.trim()) {
    errs.push(`${d.type} 类型必须填 url`);
  } else if (!/^https?:\/\//.test(d.url)) {
    errs.push("url 需以 http(s):// 开头");
  }
  return errs;
}

/** 按声明类型裁掉不相关字段，避免 stdio 的残留 url、http 的残留 command 混在文件里 */
function cleanDecl(d: McpServerDecl): McpServerDecl {
  if (d.type === "stdio") {
    return {
      type: "stdio",
      command: d.command!.trim(),
      ...(d.args?.length ? { args: d.args } : {}),
      ...(d.env && Object.keys(d.env).length ? { env: d.env } : {}),
    };
  }
  return {
    type: d.type,
    url: d.url!.trim(),
    ...(d.headers && Object.keys(d.headers).length ? { headers: d.headers } : {}),
  };
}

/** 用户侧是否已有同名条目（任一 section） */
export function userMcpExists(name: string): boolean {
  const file = readUserFile();
  return file.mcpServers?.[name] !== undefined || file.optionalServers?.[name] !== undefined;
}

/**
 * 新增/覆盖一个用户侧 MCP server。
 * 改 scope 等于换 section，所以要先把两个 section 里的同名条目都删掉再写，
 * 否则会在 global 和 optional 里各留一份（读取端合并时行为难以预期）。
 */
export function saveMcpServer(input: McpServerInput): void {
  const errs = validateMcpServer(input);
  if (errs.length) throw new Error(`MCP 配置非法：${errs.join("; ")}`);
  const file = readUserFile();
  delete file.mcpServers?.[input.name];
  delete file.optionalServers?.[input.name];
  const key = SECTION[input.scope];
  file[key] = { ...file[key], [input.name]: cleanDecl(input.decl) };
  writeUserFile(file);
}

/** 删除用户侧条目。返回是否真的删掉了东西 */
export function deleteMcpServer(name: string): boolean {
  const file = readUserFile();
  const had = userMcpExists(name);
  if (!had) return false;
  delete file.mcpServers?.[name];
  delete file.optionalServers?.[name];
  writeUserFile(file);
  return true;
}
