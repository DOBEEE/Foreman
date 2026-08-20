/**
 * Qoder 可用模型列表：启动校验与看板下拉共用一份。
 *
 * 为什么单独成文件、且必须缓存：取列表得**起一个真实的 qodercli 会话**
 * （`getAvailableModels` 是会话级 control 请求，不是纯 HTTP），一次几秒且会拉起 worker 进程。
 * 前端每开一次设置页都重开会话是不可接受的，所以进程内 TTL 缓存。
 *
 * 另一个必须守住的点：`Query extends AsyncGenerator` 且持有 worker 子进程，
 * **不 close 就会漏进程**。所以取完一定在 finally 里 close。
 */

import { query } from "@qoder-ai/qoder-agent-sdk";
import type { ModelInfo } from "@qoder-ai/qoder-agent-sdk";
import { resolveQoderAuth } from "./qoder-runtime.js";

/** 缓存有效期：与 Qoder 侧 BYOK 目录的 5 分钟缓存对齐 */
const TTL_MS = 5 * 60_000;

let cache: { at: number; models: ModelInfo[] } | undefined;
/** 同时多个请求进来只起一个会话（前端下拉 + 启动校验可能并发） */
let inflight: Promise<ModelInfo[]> | undefined;

async function fetchModels(refresh: boolean): Promise<ModelInfo[]> {
  // prompt 给空串：只为建立会话拿 control 通道，不消耗模型额度。
  // allowedTools 给空数组：这一轮不需要任何工具。
  const q = query({
    prompt: "",
    options: { auth: resolveQoderAuth(), allowedTools: [] },
  });
  try {
    return await q.getAvailableModels({ fetchStrategy: refresh ? "live" : "cache" });
  } finally {
    // 必须 close：不然每次调用漏一个 qoder-worker 子进程
    await q.close().catch(() => {});
  }
}

/**
 * 取可用模型。默认吃缓存；`refresh` 强制向服务端要最新。
 *
 * **取不到不抛**：模型列表是辅助信息（校验提示 / 下拉选项），
 * 它不可用不该让服务起不来或让设置页整页报错。返回空数组由调用方决定降级行为。
 */
export async function listQoderModels(opts?: { refresh?: boolean }): Promise<ModelInfo[]> {
  const refresh = opts?.refresh === true;
  if (!refresh && cache && Date.now() - cache.at < TTL_MS) return cache.models;
  if (inflight) return inflight;

  inflight = fetchModels(refresh)
    .then((models) => {
      cache = { at: Date.now(), models };
      return models;
    })
    .catch((error) => {
      console.warn(
        `[qoder] 取模型列表失败（不影响运行，下拉与校验降级）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // 有旧缓存就继续用旧的，比返回空更有用
      return cache?.models ?? [];
    })
    .finally(() => {
      inflight = undefined;
    });

  return inflight;
}

/**
 * 校验模型 id 是否可用。
 * 列表取不到（空）时一律返回 true——拿不到列表就不该阻拦用户的配置。
 */
export async function isQoderModelAvailable(model: string): Promise<boolean> {
  const models = await listQoderModels();
  if (!models.length) return true;
  return models.some((m) => m.value === model);
}

/** 看板下拉用的精简形状：整个 ModelInfo 太宽，前端只要这些 */
export interface QoderModelOption {
  value: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  priceFactor?: number;
  maxInputTokens?: number;
  isReasoning?: boolean;
  source?: string;
}

export function toModelOptions(models: ModelInfo[]): QoderModelOption[] {
  return models.map((m) => ({
    value: m.value,
    displayName: m.displayName,
    ...(m.description ? { description: m.description } : {}),
    ...(m.isDefault != null ? { isDefault: m.isDefault } : {}),
    ...(m.priceFactor != null ? { priceFactor: m.priceFactor } : {}),
    ...(m.maxInputTokens != null ? { maxInputTokens: m.maxInputTokens } : {}),
    ...(m.isReasoning != null ? { isReasoning: m.isReasoning } : {}),
    ...(m.source ? { source: String(m.source) } : {}),
  }));
}

/**
 * 启动时校验已配置的模型档位是否真的可用（仅 qoder 模式调用）。
 *
 * **只告警，不抛**：配错模型的表现是「每轮都失败」，启动时一次告警能立刻定位；
 * 但硬失败会让「列表接口临时不可用」也变成服务起不来，代价过大。
 * 列表取不到时（空数组）直接跳过校验，理由同上。
 */
export async function warnUnknownQoderModels(
  configured: Array<{ where: string; model?: string }>,
): Promise<void> {
  const wanted = configured.filter((c): c is { where: string; model: string } =>
    Boolean(c.model?.trim()),
  );
  if (!wanted.length) return;

  const models = await listQoderModels();
  if (!models.length) return; // 拿不到列表就不拦

  const valid = new Set(models.map((m) => m.value));
  const bad = wanted.filter((c) => !valid.has(c.model));
  if (!bad.length) return;

  const hint = models
    .slice(0, 8)
    .map((m) => m.value)
    .join(" / ");
  for (const c of bad) {
    console.warn(
      `[qoder] ${c.where} 配置的模型 "${c.model}" 不在可用列表中，本次将回落服务端默认。` +
        `可选（部分）：${hint}…（看板「模型与凭据」有完整下拉）`,
    );
  }
}
