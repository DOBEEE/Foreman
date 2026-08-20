import {
  MISSING_CREDENTIAL_CODE,
  bindHost,
  credentialGuidance,
  dashboardUrlWithToken,
  hasConfiguredProvider,
  hasModelCredential,
  hasUsableModel,
  startupGuidance,
} from "../onboarding.js";
import { isInfrastructureFailure } from "../case-harvest.js";
import { config } from "../../config/index.js";
import type { TraceRecord } from "../logger.js";

/**
 * 首启引导的确定性断言。
 *
 * 三处都是「不看着就会错」的地方：
 *   1. 凭据判定必须与 runtime 的分支一致 —— 不一致会出现「引导说配好了、真跑又说没凭据」
 *   2. 监听地址必须默认回环 —— 应用层守卫挡请求但不关端口，而看板能配凭据、改提示词
 *   3. 缺凭据的失败不能被采集成 case —— 否则每个新装环境都会攒下一条永远过不了的用例
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

process.stdout.write("\n── 凭据判定（四个分支与 runtime 一致）──\n");
{
  check("全空 → 无凭据", !hasModelCredential({}));
  check("ANTHROPIC_AUTH_TOKEN", hasModelCredential({ ANTHROPIC_AUTH_TOKEN: "t" }));
  check("ANTHROPIC_API_KEY", hasModelCredential({ ANTHROPIC_API_KEY: "k" }));
  check("OPENAI_API_KEY", hasModelCredential({ OPENAI_API_KEY: "k" }));
  check(
    "只有 ANTHROPIC_BASE_URL 也算（自建/Ollama 无需 key）",
    hasModelCredential({ ANTHROPIC_BASE_URL: "http://localhost:11434" }),
  );
  check("空字符串不算配了", !hasModelCredential({ ANTHROPIC_API_KEY: "" }));
}

process.stdout.write("\n── 引导文案 ──\n");
{
  const text = credentialGuidance();
  check("带稳定标记（下游据此排除采集）", text.includes(MISSING_CREDENTIAL_CODE));
  check("给出看板地址", text.includes("/dashboard"));
  check("三种凭据都列出来", ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL"].every((k) => text.includes(k)));
  check("说明不需要重启（否则用户会去重启，白折腾）", text.includes("不需要重启"));

  const banner = startupGuidance();
  check(
    "启动横幅只在缺凭据时出现",
    hasModelCredential() ? banner === undefined : typeof banner === "string",
    hasModelCredential() ? "本机有凭据" : "本机无凭据",
  );
}

process.stdout.write("\n── 监听地址 ──\n");
{
  const original = process.env.DASHBOARD_TOKEN;
  delete process.env.DASHBOARD_TOKEN;
  check(
    `默认只绑回环（当前 dashboardAccess=${config.dashboardAccess}）`,
    config.dashboardAccess === "lan" ? bindHost() === "0.0.0.0" : bindHost() === "127.0.0.1",
    bindHost(),
  );
  process.env.DASHBOARD_TOKEN = "secret";
  check("配了 token 才对外监听", bindHost() === "0.0.0.0", bindHost());
  if (original === undefined) delete process.env.DASHBOARD_TOKEN;
  else process.env.DASHBOARD_TOKEN = original;
}

process.stdout.write("\n── 可用模型判定（env 与供应商两条来源）──\n");
{
  // 口径必须与 resolveProvider 一致：defaultProviderId 是必要条件。
  // 没有它时 resolveProvider 直接返回未修改的 process.env，runtime 照样抛缺凭据 ——
  // 只看「存在某个带密钥的供应商」就会误判成已配置。
  check(
    "hasConfiguredProvider 以 defaultProviderId 为必要条件",
    config.defaultProviderId ? true : hasConfiguredProvider() === false,
    config.defaultProviderId ? `本机默认供应商=${config.defaultProviderId}` : "本机未设默认供应商",
  );
  check(
    "hasUsableModel = env 凭据 或 已配置供应商",
    hasUsableModel() === (hasModelCredential() || hasConfiguredProvider()),
  );
  check(
    "有 env 凭据时一定可用（不受供应商配置影响）",
    !hasModelCredential() || hasUsableModel(),
  );
  check(
    "启动横幅跟随 hasUsableModel（而不是只看 env）",
    hasUsableModel() ? startupGuidance() === undefined : typeof startupGuidance() === "string",
    hasUsableModel() ? "本机可用" : "本机不可用",
  );
}

process.stdout.write("\n── 看板链接带 token ──\n");
{
  const original = process.env.DASHBOARD_TOKEN;
  process.env.DASHBOARD_TOKEN = "s e c/ret";
  check(
    "配了 token 就带进 URL（否则点进去只有 403）",
    dashboardUrlWithToken().includes(`?token=${encodeURIComponent("s e c/ret")}`),
  );
  delete process.env.DASHBOARD_TOKEN;
  check("没配 token 时不加 query", !dashboardUrlWithToken().includes("?token="));
  if (original !== undefined) process.env.DASHBOARD_TOKEN = original;
}

process.stdout.write("\n── 缺凭据不得被采集成 case ──\n");
{
  const base = { errorSource: "runtime" as const, retryable: false };
  check(
    "缺凭据判为基础设施故障",
    isInfrastructureFailure({ ...base, error: credentialGuidance() }),
  );
  check(
    "普通 runtime 失败仍要被采集（别把真问题也排掉）",
    !isInfrastructureFailure({ ...base, error: "工具调用参数校验失败" }),
  );
  check("网关故障仍判基础设施", isInfrastructureFailure({ errorSource: "model_gateway", retryable: false }));
  check("可重试仍判基础设施", isInfrastructureFailure({ errorSource: "runtime", retryable: true }));
  check(
    "没有 error 字段不误判",
    !isInfrastructureFailure({ errorSource: "runtime", retryable: false } as Partial<TraceRecord> as never),
  );
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
