import { createHash } from "node:crypto";
import { listHiredProfiles, type AgentProfile } from "../config/agent-profile.js";
import { getProviderSecret, listProviders } from "../config/providers-store.js";

/**
 * 「导入绝不改动本机运行绑定」这条承诺的**机验**。
 *
 * 为什么需要它：现在靠 `importer.ts preserveLocalAgentFields` 逐字段抄回本机值，而那个
 * 函数依赖一张**手写的字段白名单**。将来 `AgentProfile` 新增一个本机字段而没人记得往那张
 * 表里加，导入就会静默用团队包里的值覆盖它——不报错、不告警，只是某个员工突然换了模型
 * 或工作目录。这道比对是唯一会当场发现它的东西。
 *
 * **摘要只用于比对，绝不落日志、绝不进报错文案**：它含凭据的哈希，
 * 打进日志就等于把「哪些 provider 配了 key」留在磁盘上。
 */

/**
 * 本机层里凡是导入不该碰的员工字段。**这是唯一定义处**，`importer.ts` 从这里引用——
 * 抄第二份的下场就是两边漂移，而漂移的表现是「保护少了一个字段」这种静默失效。
 */
export const LOCAL_AGENT_FIELDS = [
  "model",
  "provider",
  "contextWindow",
  "cacheRetention",
  "maxThinkingTokens",
  "workspace",
  "readRoots",
] as const;

/** 本机绑定快照：provider 整体一个摘要，员工逐个一个摘要 */
export interface LocalBindingSnapshot {
  providers: string;
  agents: Record<string, string>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 稳定序列化：键排序，保证同一状态每次得到同一串（否则会假报不一致） */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

function localFieldsOf(profile: AgentProfile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of LOCAL_AGENT_FIELDS) {
    const value = (profile as unknown as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * 拍一张本机运行绑定的快照。
 *
 * provider 密钥**只记 sha256**（记「有没有配、是不是同一个」），不记原文：
 * 比对能力一样，但即使这串被误打出来也不泄漏 key。
 */
export function snapshotLocalBindings(): LocalBindingSnapshot {
  const providers = listProviders()
    .map((p) => ({
      ...p,
      secretDigest: (() => {
        const key = getProviderSecret(p.id);
        return key ? sha256(key) : null;
      })(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const agents: Record<string, string> = {};
  for (const profile of listHiredProfiles({ includeTemp: true })) {
    agents[profile.id] = sha256(stable(localFieldsOf(profile)));
  }
  return { providers: sha256(stable(providers)), agents };
}

/**
 * 比对前后快照，返回违规项（空数组 = 本机绑定没被碰）。
 *
 * **刻意只校验「前后都存在」的员工**：导入合法地会新增员工（新员工本来就没有本机字段），
 * `replace_team` 也合法地会删掉未包含的本地员工。拿整体哈希去比会把这两种正常情况
 * 报成违规，那样的告警只会被当噪音关掉。provider 则是另一回事——导入**任何模式**
 * 都不该碰 providers.json 与 secrets.json，所以要求完全相等。
 */
export function diffLocalBindings(
  before: LocalBindingSnapshot,
  after: LocalBindingSnapshot,
): string[] {
  const violations: string[] = [];
  if (before.providers !== after.providers) {
    violations.push("模型 Provider 或凭据被改动了（导入任何模式都不该碰 providers.json / secrets.json）");
  }
  for (const [id, digest] of Object.entries(before.agents)) {
    const next = after.agents[id];
    if (next === undefined) continue; // 被合法删除（replace_team）
    if (next !== digest) {
      violations.push(`员工 ${id} 的本机绑定被改动了（模型 / provider / 工作目录 / 只读范围之一）`);
    }
  }
  return violations;
}
