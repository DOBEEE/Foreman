import { config } from "./index.js";
import { getProvider, getProviderSecret } from "./providers-store.js";

/** 供应商引用：员工 profile.provider / 主管 config.boss 都是这个形状 */
export interface ProviderRef {
  /** providers.json 里的供应商 id；缺省则用全局默认（config.defaultProviderId） */
  id?: string;
  /** 行内覆盖模型（优先级最高） */
  model?: string;
  /** 行内覆盖 baseUrl（覆盖供应商自带 baseUrl） */
  baseUrl?: string;
}

export interface ResolvedProvider {
  /** 传给 SDK query 的 env 快照（已注入正确的 ANTHROPIC_*） */
  env: NodeJS.ProcessEnv;
  /** 供应商声明的默认模型（供调用方兜底用） */
  providerDefaultModel?: string;
  /** 实际生效的供应商 id（用于日志/诊断） */
  providerId?: string;
}

/**
 * 解析一次运行该用哪套凭据与网关。
 *
 * 关键约束：ANTHROPIC_AUTH_TOKEN 与 ANTHROPIC_API_KEY **互斥**——两个一起带上，
 * 多数代理网关会直接判 401（本项目踩过这个坑）。所以命中供应商时先把两个都清掉，
 * 再按 authType 只设其一。
 *
 * 回落策略（保持零配置可跑）：
 * - 未指定供应商、也没有全局默认 → 原样返回 process.env（走 .env 里的 ANTHROPIC_*）
 * - 指定了供应商但缺密钥 → 告警并回落 process.env（不半吊子地只改 baseUrl 造成串号）
 */
export function resolveProvider(ref?: ProviderRef): ResolvedProvider {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const id = ref?.id || config.defaultProviderId;
  if (!id) return { env };

  const provider = getProvider(id);
  if (!provider) {
    console.warn(`[provider] 未找到供应商 "${id}"，回落 .env 凭据`);
    return { env };
  }
  const key = getProviderSecret(id);
  if (!key) {
    console.warn(`[provider] 供应商 "${id}" 未配置密钥，回落 .env 凭据`);
    return { env, providerDefaultModel: provider.defaultModel, providerId: id };
  }

  const baseUrl = ref?.baseUrl || provider.baseUrl;
  // 互斥：先清两个鉴权头，再按类型只设其一
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  if (provider.authType === "api_key") env.ANTHROPIC_API_KEY = key;
  else env.ANTHROPIC_AUTH_TOKEN = key;
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;

  return { env, providerDefaultModel: provider.defaultModel, providerId: id };
}
