import { config } from "../config/index.js";
import { getProvider, hasSecret } from "../config/providers-store.js";
import { resolveDingTalkCreds } from "../channels/dingtalk/creds.js";

/**
 * 首次启动引导。
 *
 * 解决的是一个逻辑死锁：**没有模型凭据时，不能靠模型去告诉用户「请配置凭据」**。
 * 所以这里全是确定性代码 —— 判定、文案、绑定地址，一次模型调用都不发。
 */

/**
 * 缺凭据错误的稳定标记。
 *
 * 需要它是因为下游要能把「配置没填」与「员工做错了」分开：新装的用户没填 key，
 * 对话拿到引导文案，很可能回一句「这不对」——那条负反馈会被采集成 case，
 * 于是每个新装环境的回归套件里都躺着一条永远无法通过的「用例」。
 * 靠关键词猜不可靠，所以用一个我们自己控制的常量当标记。
 */
export const MISSING_CREDENTIAL_CODE = "FOREMAN_NO_CREDENTIAL";

/**
 * 是否具备可用的模型凭据。
 *
 * 四个条件与 `VercelRuntime.resolveModel` 的分支**必须一致**，否则会出现
 * 「引导说配好了、真跑起来又说没凭据」这种最难查的不一致。所以那边直接调用本函数。
 */
export function hasModelCredential(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_BASE_URL,
  );
}

/**
 * 是否已配置「可用的全局默认供应商」。
 *
 * 凭据有两条来源：环境变量，以及 `providers.json` + `secrets.json`（看板设置页与 CLI
 * 首启向导写的都是后者）。只判环境变量会误报「没配凭据」。
 *
 * `defaultProviderId` 是**必要条件**，不能只看「存在某个带密钥的供应商」：
 * `resolveProvider()`（provider-env.ts:36）在没有 ref.id 也没有全局默认时，直接返回
 * 未修改的 `process.env` —— 那种情况下 runtime 照样抛缺凭据。判定必须跟着它的取值路径走。
 */
export function hasConfiguredProvider(): boolean {
  const id = config.defaultProviderId;
  if (!id) return false;
  return Boolean(getProvider(id)) && hasSecret(id);
}

/**
 * 这台机器现在能不能真的调模型 —— 「要不要引导用户去配」的唯一口径。
 *
 * 环境变量与供应商配置任一可用即可，两条路最终都汇到 `resolveModel`
 * （vercel-runtime.ts:705）的同一批分支上。
 *
 * **qoder runtime 例外**：它复用本机 qodercli 登录态（`qodercliAuth()`），凭据既不在
 * 环境变量也不在 providers.json 里，用上面那套判据一定误报「没配凭据」——而这个误报会经
 * `credentialGuidance()` 进到渠道对话里，把正常回复直接顶掉。登录态无法用同步方式探明，
 * 所以这里一律放行，真实可用性交给运行期错误（`verifyCredential` / 首次调用失败）暴露。
 */
export function hasUsableModel(): boolean {
  if (config.runtimeKind === "qoder") return true;
  return hasModelCredential() || hasConfiguredProvider();
}

/**
 * 看板地址。首启时打印它，用户点进去配凭据。
 *
 * 端口来源有讲究：纯 CLI（`foreman` 不带子命令）起的是**随机回环端口**，拿
 * `config.port` 拼出来的链接指向一个没有服务的端口 —— 引导给错地址比不给更糟。
 * 而 runtime 抛「缺凭据」时够不到 CLI 的局部变量，所以内嵌 backend 监听成功后会把
 * 真实端口写进 `FOREMAN_DASHBOARD_PORT`，这里统一读它，保证各条引导路径口径一致。
 */
export function dashboardUrl(port?: number): string {
  const actual = port ?? (Number(process.env.FOREMAN_DASHBOARD_PORT) || config.port);
  return `http://127.0.0.1:${actual}/dashboard`;
}

/**
 * 可直接点开的看板地址：配了 `DASHBOARD_TOKEN` 就把它带进 query。
 *
 * 不带的话用户点进去只会看到 403（`localhostOnly` 的 token 校验），
 * 而那个 token 是他自己设的、多半已经忘了要往哪儿传。两个入口共用一份，避免口径不一致。
 */
export function dashboardUrlWithToken(port?: number): string {
  const token = process.env.DASHBOARD_TOKEN;
  return dashboardUrl(port) + (token ? `?token=${encodeURIComponent(token)}` : "");
}

/**
 * HTTP 监听地址。
 *
 * 关键点：`localhostOnly` 是**应用层**守卫，它挡请求但不关端口 —— 监听 0.0.0.0
 * 时端口对整个网络是开的。而首启引导恰恰要求「打开看板填 key」，那个面板能配凭据、
 * 能改岗位提示词。所以默认只绑回环，显式打开 lan 或配了 token 才对外。
 */
export function bindHost(): string {
  if (process.env.DASHBOARD_TOKEN) return "0.0.0.0";
  return config.dashboardAccess === "lan" ? "0.0.0.0" : "127.0.0.1";
}

/** 缺凭据时给用户的固定文案。渠道对话与启动横幅共用一份，避免两处说法不一致 */
export function credentialGuidance(port?: number): string {
  return (
    `还没有配置模型凭据，所以我暂时没法思考。[${MISSING_CREDENTIAL_CODE}]\n\n` +
    `打开 ${dashboardUrl(port)} → 设置 → 模型与凭据，填一个：\n` +
    `  · Anthropic：ANTHROPIC_API_KEY\n` +
    `  · OpenAI：OPENAI_API_KEY\n` +
    `  · 自建/兼容网关（含 Ollama）：ANTHROPIC_BASE_URL\n\n` +
    `填完点「测试」验证连通，然后再跟我说话就行 —— 不需要重启。`
  );
}

/** 启动横幅。有可用模型时返回 undefined（没事就不刷屏） */
export function startupGuidance(port?: number): string | undefined {
  if (hasUsableModel()) return undefined;
  return (
    `\n${"─".repeat(60)}\n` +
    `⚠️  还没有模型凭据 —— 现在跟员工说话只会拿到引导文案。\n\n` +
    `   打开 ${dashboardUrlWithToken(port)} → 设置 → 模型与凭据\n` +
    `   或在 .env 里填 ANTHROPIC_API_KEY / OPENAI_API_KEY / ANTHROPIC_BASE_URL\n` +
    `   CLI 里输入 /setup 可随时再看这份指引，foreman setup 可重跑配置向导\n` +
    `${"─".repeat(60)}\n`
  );
}

/**
 * `/setup` 的完整指引：模型凭据 + 渠道接入，一屏说完。
 *
 * 同样是零 LLM 的确定性文案 —— 没凭据时模型本来就不能用，
 * 让模型来讲「怎么配模型」是死锁。
 *
 * @param port    实际在听的端口（看板链接用）
 * @param remote  true=CLI 连的是远端服务，此时本机凭据判定对那台机器无效，需注明
 */
export function setupGuide(port?: number, remote = false): string {
  const model = hasUsableModel()
    ? hasConfiguredProvider()
      ? `已配置 ✅（供应商 ${config.defaultProviderId}）`
      : "已配置 ✅（环境变量）"
    : "未配置 ⚠️";
  // 与渠道侧同一口径：凭据可能来自看板的 credential store，不只是环境变量
  const dingtalk = resolveDingTalkCreds() ? "已配置 ✅" : "未配置（不影响 CLI 使用）";
  return [
    `当前状态${remote ? "（本机判定，远端服务以那台机器上的配置为准）" : ""}：`,
    `  模型凭据：${model}`,
    `  钉钉渠道：${dingtalk}`,
    ``,
    `① 配模型 —— 跑 foreman setup 在命令行里填完，或打开看板：`,
    `   ${dashboardUrlWithToken(port)} → 设置 → 模型与凭据`,
    `   新增供应商后点「测试」真发一次请求验证连通，填完即时生效、不用重启。`,
    `   也可以走环境变量（三者任选其一）：`,
    `     ANTHROPIC_API_KEY=...                 # Anthropic 直连`,
    `     OPENAI_API_KEY=...                    # OpenAI 兼容`,
    `     ANTHROPIC_BASE_URL=...                # 自建/代理网关（含 Ollama），配代理时用 ANTHROPIC_AUTH_TOKEN`,
    ``,
    `② 接钉钉（想在群里跟主管说话才需要）：`,
    `   看板 → 设置 → 渠道，或在 .env 里填这两个：`,
    `     DINGTALK_CLIENT_ID=<AppKey>`,
    `     DINGTALK_CLIENT_SECRET=<AppSecret>`,
    `   钉钉开放平台建企业内部应用机器人，消息接收模式选 Stream，无需公网回调。`,
    `   配好后 foreman 启动时自动连接；不想连就加 --no-channels。`,
    ``,
    `③ 更细的配置都在看板 —— 每员工模型覆盖、MCP、主管人设、组织图、执行过程回放：`,
    `   ${dashboardUrlWithToken(port)}`,
  ].join("\n");
}

/**
 * 真验一次凭据（走环境变量那条路）。
 *
 * 为什么不能只判非空：填了一个过期或写错的 key，`hasModelCredential` 一样返回 true，
 * 用户以为配好了，直到第一个真任务才炸 —— 而那时看到的是网关返回的 401，
 * 跟「你没配 key」看起来完全是两件事，最难查。这里花一次最小调用把它提前暴露。
 *
 * 想验某个具体供应商用 `testProvider(id)`：它按 provider id 解析 env，更准。
 */
export async function verifyCredential(): Promise<{ ok: boolean; ms: number; detail: string }> {
  const startedAt = Date.now();
  if (!hasUsableModel()) {
    return { ok: false, ms: 0, detail: "未配置任何凭据" };
  }
  const { getRuntime } = await import("../runtime/index.js");
  try {
    const result = await getRuntime().complete({ prompt: "ping（仅测试连通性，请只回复 pong）" });
    return {
      ok: !result.isError,
      ms: Date.now() - startedAt,
      detail: result.text.slice(0, 200),
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 按供应商 id 真发一次最小调用验连通。
 *
 * 与 `verifyCredential` 的区别：这里用 `resolveProvider({id})` 注入那个供应商自己的
 * 网关与密钥，而不是走环境变量 —— 刚在向导/看板里存下的 key 还没进 `process.env`，
 * 只有这条路验的才是用户真正配的东西。
 *
 * 看板的 `POST /providers/:id/test` 与 CLI 首启向导共用它，避免两处判定不一致。
 */
export async function testProvider(
  id: string,
  model?: string,
): Promise<{ ok: boolean; model: string; ms: number; reply?: string; error?: string }> {
  const provider = getProvider(id);
  const startedAt = Date.now();
  if (!provider) return { ok: false, model: "", ms: 0, error: `供应商 ${id} 不存在` };
  if (!hasSecret(id))
    return { ok: false, model: "", ms: 0, error: "尚未配置密钥，先保存 key 再测试" };

  const { resolveProvider } = await import("../config/provider-env.js");
  const { getRuntime } = await import("../runtime/index.js");
  const prov = resolveProvider({ id });
  const picked = model || provider.defaultModel || config.model;
  try {
    const result = await getRuntime().complete({
      prompt: "ping（仅测试连通性，请只回复 pong）",
      model: picked,
      env: prov.env as Record<string, string>,
    });
    return {
      ok: !result.isError,
      model: picked ?? "(SDK 默认)",
      ms: Date.now() - startedAt,
      reply: result.text.slice(0, 200),
      ...(result.isError ? { error: result.text.slice(0, 300) } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      model: picked ?? "(SDK 默认)",
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
