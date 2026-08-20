import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "./index.js";

/**
 * 模型供应商 = 一个 Anthropic 兼容网关（idealab / 官方 / 自建代理…）。
 * 分两处落盘，都在 <runtimeDir> 下、不进 git：
 * - providers.json：**不含密钥**的元信息（baseUrl / 鉴权类型 / 默认模型），可随便回显
 * - secrets.json（0600）：providerId → key，只写不回显（GET 一律掩码）
 * 员工 / 主管在各自配置里只引用 provider id + 可选行内覆盖，不各自抄一份 key。
 */
export interface ProviderInfo {
  /** 唯一 id（slug）：员工/主管配置里引用它 */
  id: string;
  /** 展示名 */
  name: string;
  /** 网关基址（ANTHROPIC_BASE_URL）；留空走 SDK 默认（官方） */
  baseUrl?: string;
  /**
   * 鉴权头类型（与网关约定）：
   * - auth_token → ANTHROPIC_AUTH_TOKEN（多数代理网关，如 idealab）
   * - api_key    → ANTHROPIC_API_KEY（官方 Anthropic）
   * 两者互斥：注入时只设其一、并清掉另一个（曾因两个都带上被网关判 401）。
   */
  authType: "auth_token" | "api_key";
  /** 该供应商的默认模型（引用它的员工没单独指定 model 时用） */
  defaultModel?: string;
  createdAt?: string;
  createdBy?: string;
}

const ID_RE = /^[a-z][a-z0-9_-]{1,39}$/;

function providersFile(): string {
  return join(config.runtimeDir, "providers.json");
}
function secretsFile(): string {
  return join(config.runtimeDir, "secrets.json");
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch (error) {
    console.warn(`[providers] 解析 ${file} 失败:`, error);
    return fallback;
  }
}

/** 原子写：写临时文件再 rename，避免半截文件被并发读到 */
function atomicWrite(file: string, data: string, mode?: number): void {
  mkdirSync(config.runtimeDir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { encoding: "utf-8", ...(mode ? { mode } : {}) });
  if (mode) {
    try {
      chmodSync(tmp, mode);
    } catch {
      /* 权限设置失败不阻断写入 */
    }
  }
  renameSync(tmp, file);
}

// ─── providers.json（元信息，可回显） ──────────────────────────

export function listProviders(): ProviderInfo[] {
  const arr = readJson<ProviderInfo[]>(providersFile(), []);
  return Array.isArray(arr) ? arr : [];
}

export function getProvider(id: string): ProviderInfo | undefined {
  return listProviders().find((p) => p.id === id);
}

export function validateProvider(p: Partial<ProviderInfo>): string[] {
  const errs: string[] = [];
  if (typeof p.id !== "string" || !ID_RE.test(p.id))
    errs.push("id 非法：需 2-40 位小写字母开头的 slug（字母/数字/-/_）");
  if (typeof p.name !== "string" || !p.name.trim()) errs.push("name 不能为空");
  if (p.authType !== "auth_token" && p.authType !== "api_key")
    errs.push("authType 只能是 auth_token 或 api_key");
  if (p.baseUrl != null && p.baseUrl !== "" && !/^https?:\/\//.test(p.baseUrl))
    errs.push("baseUrl 需以 http(s):// 开头");
  return errs;
}

/** 新增/覆盖一个供应商（不含密钥） */
export function saveProvider(p: ProviderInfo): void {
  const errs = validateProvider(p);
  if (errs.length) throw new Error(`供应商配置非法：${errs.join("; ")}`);
  const list = listProviders();
  const idx = list.findIndex((x) => x.id === p.id);
  const clean: ProviderInfo = {
    id: p.id,
    name: p.name,
    authType: p.authType,
    ...(p.baseUrl ? { baseUrl: p.baseUrl.replace(/\/+$/, "") } : {}),
    ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}),
    createdAt: p.createdAt ?? new Date().toISOString(),
    ...(p.createdBy ? { createdBy: p.createdBy } : {}),
  };
  if (idx >= 0) list[idx] = { ...list[idx], ...clean };
  else list.push(clean);
  atomicWrite(providersFile(), `${JSON.stringify(list, null, 2)}\n`);
}

export function deleteProvider(id: string): void {
  const list = listProviders().filter((p) => p.id !== id);
  atomicWrite(providersFile(), `${JSON.stringify(list, null, 2)}\n`);
  deleteSecret(id);
}

// ─── secrets.json（密钥，0600，只写不回显） ─────────────────────

function readSecrets(): Record<string, string> {
  return readJson<Record<string, string>>(secretsFile(), {});
}

export function getProviderSecret(id: string): string | undefined {
  return readSecrets()[id];
}

export function hasSecret(id: string): boolean {
  return Boolean(readSecrets()[id]);
}

export function setProviderSecret(id: string, key: string): void {
  const secrets = readSecrets();
  if (key) secrets[id] = key;
  else delete secrets[id];
  atomicWrite(secretsFile(), `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
}

function deleteSecret(id: string): void {
  const secrets = readSecrets();
  if (secrets[id] == null) return;
  delete secrets[id];
  atomicWrite(secretsFile(), `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
}

/** 密钥掩码：只露头 4 尾 4，中间打码。任何 GET 都用它，绝不回显明文 */
export function maskSecret(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/** providers.json 的 mtime（缺失=0），config 之外的热更判定可用 */
export function providersMtime(): number {
  try {
    return statSync(providersFile()).mtimeMs;
  } catch {
    return 0;
  }
}
