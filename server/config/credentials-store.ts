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
import { maskSecret } from "./providers-store.js";

/**
 * 命名密钥库：把原本散在 .env 里的「渠道 / 搜索」凭据搬到 dashboard 配置，
 * 落盘 <runtimeDir>/credentials.json（0600，只写不回显，与 providers 的 secrets.json 同规格）。
 *
 * 与 providers-store 的 secrets.json 分开：那份按 provider id 索引（模型网关密钥），
 * 这份是**固定命名槽位**（渠道/工具凭据），语义不同，混在一起会让键空间打架。
 *
 * 每个槽位映射一个历史 env 名。加载凭据的地方一律「store 值 || process.env 兜底」，
 * 存量 .env 用户不受影响；**写盘时同步 process.env**，让每次读 env 的消费方
 * （钉钉 push/media、MCP 按 run 组装的 Tavily/Exa）无需重启即用上新值。
 */
export const CREDENTIAL_SLOTS = {
  dingtalk_client_secret: "DINGTALK_CLIENT_SECRET",
  tavily_api_key: "TAVILY_API_KEY",
  exa_api_key: "EXA_API_KEY",
} as const;

export type CredentialSlot = keyof typeof CREDENTIAL_SLOTS;

/**
 * 槽位固定不做动态派生：一种渠道类型只跑一个实例（要接第二个钉钉企业请起第二个服务实例，
 * 换 runtimeDir——员工/知识库/工作台都是服务实例级共享的，跨企业共用等于信息泄漏）。
 */
export function envNameOf(slot: CredentialSlot): string {
  return CREDENTIAL_SLOTS[slot];
}

export function isCredentialSlot(key: string): key is CredentialSlot {
  return Object.prototype.hasOwnProperty.call(CREDENTIAL_SLOTS, key);
}

function credentialsFile(): string {
  return join(config.runtimeDir, "credentials.json");
}

function readAll(): Record<string, string> {
  const file = credentialsFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, string>;
  } catch (error) {
    console.warn(`[credentials] 解析 ${file} 失败:`, error);
    return {};
  }
}

/** 原子写 + 0600：写临时文件再 rename，避免半截文件被并发读到 */
function writeAll(data: Record<string, string>): void {
  mkdirSync(config.runtimeDir, { recursive: true });
  const file = credentialsFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* 权限设置失败不阻断写入 */
  }
  renameSync(tmp, file);
}

/** 读取某槽位的凭据：store 优先，缺失回落 .env 兜底（兼容存量用户） */
export function getCredential(slot: CredentialSlot): string | undefined {
  return readAll()[slot] || process.env[envNameOf(slot)] || undefined;
}

export function hasCredential(slot: CredentialSlot): boolean {
  return Boolean(getCredential(slot));
}

/**
 * 写入/清除某槽位（空串=清除）。写盘同时同步 process.env，让每次读 env 的消费方即时生效；
 * 钉钉 Stream 长连接不吃 env，需另调 restartChannel 重连。
 */
export function setCredential(slot: CredentialSlot, value: string): void {
  const all = readAll();
  const env = envNameOf(slot);
  if (value) {
    all[slot] = value;
    process.env[env] = value;
  } else {
    delete all[slot];
    delete process.env[env];
  }
  writeAll(all);
}

/** 各槽位状态（只回存在性 + 掩码，绝不吐明文）；hasValue 含 .env 兜底 */
export function listCredentialStatus(): Array<{
  slot: CredentialSlot;
  envName: string;
  hasValue: boolean;
  mask: string;
  fromEnvFallback: boolean;
}> {
  const stored = readAll();
  return (Object.keys(CREDENTIAL_SLOTS) as CredentialSlot[]).map((slot) => {
    const envName = envNameOf(slot);
    const value = stored[slot] || process.env[envName] || "";
    return {
      slot,
      envName,
      hasValue: Boolean(value),
      mask: maskSecret(value),
      fromEnvFallback: !stored[slot] && Boolean(process.env[envName]),
    };
  });
}

/** credentials.json 的 mtime（缺失=0），需要热更判定时可用 */
export function credentialsMtime(): number {
  try {
    return statSync(credentialsFile()).mtimeMs;
  } catch {
    return 0;
  }
}
