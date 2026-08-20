# foreman 使用答疑

## 项目是什么

foreman 是基于 Claude Agent SDK 的多 agent 服务模板：HTTP 输入、SSE/JSON 输出、声明式 MCP 接入、多 agent 路由、钉钉等 IM 渠道接入。

## 如何新增一个 agent

两步：

1. 在 `src/agents/` 创建 `xxx.agent.ts`，继承 `BaseAgent`，声明 `name`、`description`，可选配置 `systemPromptFile`（长提示词放 `src/agents/prompts/`）、`model`、`maxTurns`、`allowedTools`、`channels`、`routeHint`、`paramsSchema` 等
2. 在 `src/agents/registry.ts` 的 `agents` 数组里实例化注册

之后即可通过 `POST /api/agents/xxx/run` 显式调用；声明了 `channels` 的还会自动进入对应渠道的路由候选。

## 钉钉机器人怎么配置

1. 钉钉开放平台创建企业内部应用机器人，获取 AppKey / AppSecret，开启消息接收并选 Stream 模式
2. `.env` 填 `DINGTALK_CLIENT_ID`（AppKey）和 `DINGTALK_CLIENT_SECRET`（AppSecret）
3. 重启服务，日志出现 `[dingtalk] stream connected` 即成功。私聊和群聊 @ 消息都会推给绑定了 `dingtalk` 渠道的 agent

注意：同一机器人同时只能有一个服务实例在线，多实例会重复收消息并重复回复。

## 路由是怎么工作的

渠道消息（钉钉）或 `POST /api/route/run` 进入后，路由器 `routeAgent` 按顺序决策：命中 agent 的 `routePatterns` 正则直接路由（命名捕获组成为 params）；否则一次轻量 LLM 调用按各 agent 的 `routeHint` 和 `paramsSchema` 分类并提取入参；失败回落 `channelDefault` agent。

## 鉴权环境变量怎么填

走代理时只填 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，**不要再填 `ANTHROPIC_API_KEY`**——两个同时存在时 CLI 会同时带两个鉴权头，代理会返回 401。

## 执行日志在哪里

每次对话的执行日志写在 `logs/runs-YYYY-MM-DD.jsonl`（每行一条 JSON），包含 prompt、最终回复、tool 调用、usage 等。`logs/` 已被 git 忽略。

## 常见 agent 一览

- `assistant`：只读答疑助手（本地知识库 + 可选代码仓库 + 联网检索），所有渠道的路由兜底。工作目录是隔离的 `/tmp/foreman/assistant`，知识源由 `KNOWLEDGE_DIR` / `ASSISTANT_CODE_ROOTS` 配置，越界与凭据类路径被钩子拦截
- `code-review`：仓库代码评审，clone 后输出评审报告
- `alert-diagnosis`：告警根因定位，依据用户提供的告警/日志/仓库地址排查
- `default`：通用编码 agent，具备全部工具
