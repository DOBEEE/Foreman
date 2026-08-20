import React, { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import {
  deleteProvider,
  saveProvider,
  setProviderSecret,
  validateProvider,
} from "../config/providers-store.js";
import { patchSettings } from "../config/settings-store.js";
import { dashboardUrlWithToken, testProvider } from "../core/onboarding.js";

/**
 * 首启配置向导。
 *
 * 只问**不填就跑不起来**的那一项：模型凭据。其余（每员工模型覆盖、MCP、主管人设、
 * 渠道细节）留给看板 —— 那边已经是成品表单，在终端里重做一遍不划算。
 *
 * 为什么是独立的一次 render 而不是塞进 App：App 里只有一个 `useInput` 和一个没传 `focus`
 * 的 `TextInput`，再挂一个输入框会两边同时吃按键。走完这次 render 再渲染 App，输入焦点
 * 天然只有一个。
 *
 * 全程零 LLM：没凭据时模型本来就不能用，让模型来讲「怎么配模型」是死锁。
 */

/** 向导写入的供应商 id。固定一个，重跑向导就是覆盖它，不会攒出一堆 provider-1/2/3 */
const PROVIDER_ID = "default";

/** 预填的默认模型：与 runtime resolveModel 的兜底值一致，省得用户去查名字 */
const DEFAULT_MODEL = "claude-opus-5";

export interface ProviderDraft {
  /** 网关地址；留空 = Anthropic 官方 */
  baseUrl: string;
  authType: "auth_token" | "api_key";
  key: string;
  /** 默认模型；留空则由全局 model / SDK 兜底 */
  model: string;
}

/**
 * 校验并落盘。**不碰网络** —— 连通性测试是单独一步（testProvider），
 * 拆开是为了让落盘语义可被 fixture 断言：字段形状、secrets 权限、defaultProviderId 三件事
 * 错了都不会当场报错，只会在「配好了却说没凭据」时才发现。
 *
 * @returns 出错时返回人话错误；成功返回 undefined
 */
export function persistProvider(draft: ProviderDraft): string | undefined {
  const baseUrl = draft.baseUrl.trim().replace(/\/+$/, "");
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) return "网关地址需以 http:// 或 https:// 开头";
  if (!draft.key.trim()) return "密钥不能为空";

  const provider = {
    id: PROVIDER_ID,
    name: baseUrl ? new URL(baseUrl).hostname : "anthropic",
    authType: draft.authType,
    ...(baseUrl ? { baseUrl } : {}),
    ...(draft.model.trim() ? { defaultModel: draft.model.trim() } : {}),
    createdBy: "setup-wizard",
  };
  const errs = validateProvider(provider);
  if (errs.length) return errs.join("; ");

  try {
    // 先删再写：saveProvider 对已存在的 id 是**浅合并**，而向导提交的是一份完整定义。
    // 不删的话，用户把 baseUrl 清空想改回官方直连时旧地址会留着 —— 于是拿新 key 往旧网关
    // 发请求，而且不报错。删除会连带清掉旧密钥，紧接着就写新的，顺序是安全的。
    deleteProvider(PROVIDER_ID);
    saveProvider(provider);
    setProviderSecret(PROVIDER_ID, draft.key.trim());
    // defaultProviderId 是必要的一步：不设它 resolveProvider 会直接回落 process.env，
    // 于是「配好了但还是说没凭据」
    patchSettings({ defaultProviderId: PROVIDER_ID });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return undefined;
}

type Step = "baseUrl" | "authType" | "key" | "model" | "testing" | "done" | "failed";

const AUTH_TYPES = [
  {
    value: "auth_token" as const,
    label: "auth_token",
    hint: "多数代理网关（走 ANTHROPIC_AUTH_TOKEN）",
  },
  {
    value: "api_key" as const,
    label: "api_key",
    hint: "Anthropic 官方 / OpenAI 兼容（走 ANTHROPIC_API_KEY）",
  },
];

interface WizardProps {
  /** 实际在听的端口，用于给出正确的看板地址 */
  port?: number;
  /** 结束回调：saved=是否真的写下了可用配置 */
  onFinish: (saved: boolean) => void;
}

function Wizard({ port, onFinish }: WizardProps): React.ReactElement {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("baseUrl");
  const [baseUrl, setBaseUrl] = useState("");
  const [authIdx, setAuthIdx] = useState(0);
  const [key, setKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  const finish = (saved: boolean) => {
    onFinish(saved);
    exit();
  };

  /** 落盘 + 真发一次 ping。落盘在前：testProvider 按 provider id 解析凭据，得先有记录 */
  const saveAndTest = async (finalModel: string) => {
    const problem = persistProvider({
      baseUrl,
      authType: AUTH_TYPES[authIdx].value,
      key,
      model: finalModel,
    });
    if (problem) {
      setError(problem);
      setStep("failed");
      return;
    }
    setStep("testing");
    const r = await testProvider(PROVIDER_ID);
    if (r.ok) {
      setResult(`${r.model} · ${r.ms}ms · 回包：${(r.reply ?? "").trim().slice(0, 40)}`);
      setStep("done");
    } else {
      setError(r.error ?? "未知错误");
      setStep("failed");
    }
  };

  useInput((ch, inputKey) => {
    // Esc 随时跳过：向导不能变成进不去 CLI 的墙
    if (inputKey.escape && step !== "testing") {
      finish(false);
      return;
    }
    if (step === "authType") {
      if (inputKey.upArrow) setAuthIdx((i) => (i - 1 + AUTH_TYPES.length) % AUTH_TYPES.length);
      if (inputKey.downArrow) setAuthIdx((i) => (i + 1) % AUTH_TYPES.length);
      if (inputKey.return) setStep("key");
      return;
    }
    if (step === "done" && inputKey.return) finish(true);
    if (step === "failed") {
      if (ch === "r") {
        setError("");
        setStep("baseUrl");
      }
      if (ch === "s") finish(false); // 配置已落盘，只是没验通 —— 可能是网关抖了
    }
  });

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold color="cyan">
        配置模型凭据（4 步，Esc 可跳过）
      </Text>
      <Text dimColor>更细的配置在看板：{dashboardUrlWithToken(port)}</Text>
      <Box height={1} />

      {step === "baseUrl" && (
        <Box flexDirection="column">
          <Text>
            <Text color="yellow">1/4</Text> 网关地址（自建 / 代理网关填 https://…，直连
            Anthropic 官方留空回车）
          </Text>
          <Box>
            <Text color="cyan">{"› "}</Text>
            <TextInput
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder="留空 = Anthropic 官方"
              onSubmit={() => {
                const v = baseUrl.trim();
                if (v && !/^https?:\/\//.test(v)) {
                  setError("需以 http:// 或 https:// 开头");
                  return;
                }
                setError("");
                setStep("authType");
              }}
            />
          </Box>
          {error ? <Text color="red">{error}</Text> : null}
        </Box>
      )}

      {step === "authType" && (
        <Box flexDirection="column">
          <Text>
            <Text color="yellow">2/4</Text> 鉴权类型（↑↓ 选择，回车确认）
          </Text>
          {AUTH_TYPES.map((t, i) => (
            <Text key={t.value} color={i === authIdx ? "cyan" : undefined}>
              {i === authIdx ? "❯ " : "  "}
              {t.label} <Text dimColor>— {t.hint}</Text>
            </Text>
          ))}
        </Box>
      )}

      {step === "key" && (
        <Box flexDirection="column">
          <Text>
            <Text color="yellow">3/4</Text> 密钥（只写入本机 ~/.foreman/secrets.json，0600）
          </Text>
          <Box>
            <Text color="cyan">{"› "}</Text>
            <TextInput
              value={key}
              onChange={setKey}
              mask="*"
              placeholder="粘贴 key"
              onSubmit={() => {
                if (!key.trim()) {
                  setError("密钥不能为空");
                  return;
                }
                setError("");
                setStep("model");
              }}
            />
          </Box>
          {error ? <Text color="red">{error}</Text> : null}
        </Box>
      )}

      {step === "model" && (
        <Box flexDirection="column">
          <Text>
            <Text color="yellow">4/4</Text> 默认模型（回车接受）
          </Text>
          <Box>
            <Text color="cyan">{"› "}</Text>
            <TextInput value={model} onChange={setModel} onSubmit={() => void saveAndTest(model)} />
          </Box>
        </Box>
      )}

      {step === "testing" && (
        <Text>
          <Spinner type="dots" /> 正在真发一次请求验证连通…
        </Text>
      )}

      {step === "done" && (
        <Box flexDirection="column">
          <Text color="green">✅ 连通成功 · {result}</Text>
          <Text dimColor>已设为全局默认供应商，改配置随时可去看板。回车开始对话。</Text>
        </Box>
      )}

      {step === "failed" && (
        <Box flexDirection="column">
          <Text color="red">❌ 验证失败：{error}</Text>
          <Text dimColor>
            配置已写入本机（可去看板改）。按 r 重填，按 s 跳过先进 CLI。
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * 跑一次向导。
 * @returns true = 写下了验证通过的配置；false = 用户跳过 / 未验通
 */
export async function runSetupWizard(port?: number): Promise<boolean> {
  let saved = false;
  const { waitUntilExit } = render(
    <Wizard
      port={port}
      onFinish={(ok) => {
        saved = ok;
      }}
    />,
    { exitOnCtrlC: true },
  );
  await waitUntilExit();
  return saved;
}
