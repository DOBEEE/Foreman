import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { persistProvider } from "../setup-wizard.js";
import { config } from "../../config/index.js";
import { getProvider, getProviderSecret } from "../../config/providers-store.js";
import { hasConfiguredProvider, hasUsableModel } from "../../core/onboarding.js";

/**
 * 首启向导「落盘」这一步的断言。
 *
 * 为什么必须机器验：这三件事错了都**不会当场报错**，只会在「我明明配好了，它还说没凭据」
 * 时才发现，而那时看起来像模型或网关的问题。
 *   1. defaultProviderId 必须写 —— 不写 resolveProvider 直接回落 process.env
 *   2. 密钥必须落到 0600 的 secrets.json，且不进 providers.json
 *   3. 重跑向导必须覆盖同一条记录，不能攒出一堆 provider
 *
 * 本 fixture 只管落盘，不碰网络（连通性测试是 testProvider 的事）。
 * test-runner 会给每个 fixture 独立的 RUNTIME_DIR，所以这里直接写真文件。
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

process.stdout.write("\n── 入参校验（挡在落盘之前）──\n");
{
  check(
    "网关地址必须带协议头",
    persistProvider({ baseUrl: "idealab.example.com", authType: "api_key", key: "k", model: "" }) !==
      undefined,
  );
  check(
    "密钥不能为空",
    persistProvider({ baseUrl: "", authType: "api_key", key: "   ", model: "" }) !== undefined,
  );
  check("校验失败时不写任何文件", !existsSync(join(config.runtimeDir, "providers.json")));
}

process.stdout.write("\n── 代理网关那条路（baseUrl + auth_token）──\n");
{
  const problem = persistProvider({
    baseUrl: "https://idealab.example.com/api/code/",
    authType: "auth_token",
    key: "tok-abc123",
    model: "claude-opus-5",
  });
  check("落盘成功", problem === undefined, problem ?? "");

  const p = getProvider("default");
  check("供应商已写入", Boolean(p));
  check("baseUrl 去掉了尾部斜杠", p?.baseUrl === "https://idealab.example.com/api/code", p?.baseUrl);
  check("authType 原样保留（与鉴权头互斥逻辑对应）", p?.authType === "auth_token");
  check("defaultModel 已记下", p?.defaultModel === "claude-opus-5");
  check("name 用主机名，不用让用户再起名", p?.name === "idealab.example.com", p?.name);

  check("密钥可被 resolveProvider 取到", getProviderSecret("default") === "tok-abc123");
  const providersRaw = readFileSync(join(config.runtimeDir, "providers.json"), "utf-8");
  check("密钥绝不写进 providers.json（那份是可回显的）", !providersRaw.includes("tok-abc123"));
  const mode = statSync(join(config.runtimeDir, "secrets.json")).mode & 0o777;
  check("secrets.json 权限 0600", mode === 0o600, `0${mode.toString(8)}`);

  check(
    "写了 defaultProviderId —— 少这一步就会「配好了却说没凭据」",
    config.defaultProviderId === "default",
    String(config.defaultProviderId),
  );
  check("hasConfiguredProvider 随之为真", hasConfiguredProvider());
  check("hasUsableModel 随之为真（向导跑完不该再弹）", hasUsableModel());
}

process.stdout.write("\n── 重跑向导：覆盖而不是堆积 ──\n");
{
  const problem = persistProvider({
    baseUrl: "",
    authType: "api_key",
    key: "sk-second",
    model: "",
  });
  check("第二次落盘成功", problem === undefined, problem ?? "");
  const list = JSON.parse(readFileSync(join(config.runtimeDir, "providers.json"), "utf-8"));
  check("仍然只有一条供应商记录", Array.isArray(list) && list.length === 1, `${list.length} 条`);
  const p = getProvider("default");
  check("authType 已被覆盖", p?.authType === "api_key");
  check("留空 baseUrl 时不留旧值（官方直连）", p?.baseUrl === undefined, p?.baseUrl ?? "(无)");
  check("留空模型时不写 defaultModel", p?.defaultModel === undefined, p?.defaultModel ?? "(无)");
  check("密钥已换成新的", getProviderSecret("default") === "sk-second");
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
