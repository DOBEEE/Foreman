---
name: web-search
description: Use whenever a task needs information from the public internet — searching the web, checking a library version or API signature, looking up an error message, or reading a documentation page or any URL the user pasted. This environment has no built-in WebSearch/WebFetch tools; web access goes through MCP (`mcp__tavily` / `mcp__websearch`, browser as fallback) and this skill tells you which one to use and which domains are actually reachable. Load it before concluding that "网络被封 / 联网不可用" — that conclusion is almost always wrong here.
---

# 本环境的联网检索方式

## 先说结论：外网是通的，别误报「联网不可用」

本环境**没有** `WebSearch` / `WebFetch` 这两个工具（运行时的内置工具袋里就不注册它们），
所以你不会、也无法调用它们。归因记在这里，免得把「没有联网工具」误判成「外网被封」：

- **WebSearch** 是 Anthropic 的服务端工具，需由模型 API 侧执行；当前模型网关（idealab）不支持。
- **WebFetch** 抓取前要向 `claude.ai` 校验目标域名，而 `claude.ai` 被网络策略拦截 —— 校验失败后
  **任何**域名都抓不了，与目标站点本身是否可达无关。

**外网是通的，只是通路不同**（见下面两条）。任何情况下都不要向用户报告「网络被封 / 联网不可用」。

## 正确通路一：搜索类 MCP（首选，比浏览器快一个数量级）

**优先 `mcp__tavily`（已配 key，结果质量明显更高）**：

- `tavily_search` —— 关键词检索，返回标题 + URL + **正文摘录**（常常一条就够用，不必再抓页面）
- `tavily_extract` —— 抓指定 URL 正文；`tavily_crawl` / `tavily_map` —— 站点批量抓取与结构探查
- `tavily_research` —— 多步深度检索，贵，只在确实需要综述时用

**兜底 `mcp__websearch`（免鉴权、无额度限制）**：

- `search` —— 引擎可选 `bing` / `baidu` / `sogou` / `csdn` / `juejin`（默认 bing）
- `fetchWebContent` —— 抓指定 URL 正文（markdown）。**用户粘了链接要读内容就用它**
- `fetchGithubReadme` / `fetchCsdnArticle` / `fetchJuejinArticle` / `fetchLinuxDoArticle` —— 对应站点专用抓取，比通用抓取干净

**怎么选**：技术类、英文、要精确命中 → tavily。中文社区内容（掘金/CSDN/知乎）或只是抓一个已知 URL → websearch 够用。

实测对比（同一 query「Vercel AI SDK streamText 用法」）：tavily 首条即命中带可运行代码的
社区帖；websearch 前 4 条全是「如何部署到 Vercel」，与 streamText 无关。所以**别拿 websearch
的结果当"查不到"的依据** —— 换 tavily 再试一次。

反过来，tavily 有**月度额度**（免费档 1000 次/月），别用它做无脑重试或一次任务里反复搜同一个词。

岗位没被授权这些工具时，找工具管理员「小装」开通，不要自己绕路。

## 正确通路二：浏览器 MCP（兜底）

仅在这些情况用 `mcp__playwright`：**内网站点**、**需要登录**、**要看 JS 渲染后的结果**、或要在页面上实际操作。

1. `mcp__playwright__browser_navigate` 打开目标页
2. `mcp__playwright__browser_find` 按关键词定位正文（比整页快照省 token）
3. 结构不熟、find 定位不到时才 `browser_snapshot`
4. 查完 `mcp__playwright__browser_close`

## 不要做的事

- **别用 Bash curl 直接抓搜索引擎**。实测 `curl "https://www.bing.com/search?q=..."` 会 302 到 cn.bing.com、
  返回 200 与 100KB HTML，但结果节点 `li.b_algo` 数量为 **0** —— 反爬 + JS 渲染，解析不到任何结果，纯浪费步数。
  百度同理返回反爬页面。要搜索就用上面的 `mcp__websearch`。
- 出口有 allowlist，但**必须区分「抓搜索页」和「调官方 API」**：
  - **可达**：bing / baidu 站点；`www.googleapis.com` 与 `customsearch.googleapis.com`
    （Google Custom Search JSON API）；`api.tavily.com`；`api.exa.ai`；`api.bochaai.com`；
    百度 `aip.baidubce.com` / `qianfan.baidubce.com`；`dashscope.aliyuncs.com`；`open.bigmodel.cn`。
  - **不可达**：`api.search.brave.com`、`html.duckduckgo.com`、`r.jina.ai`、`claude.ai`、
    `api.anthropic.com`、公共 SearXNG 实例（如 `searx.be`）。别在这些域名上反复重试。
  - ⚠️ **别把 Google 整个当成不可达** —— 本条曾长期写错。实测
    `curl https://www.googleapis.com/customsearch/v1?q=test` 返回的是 Google 自己的 403 JSON
    （`Method doesn't allow unregistered callers ... Please use API Key`），那是 **API 在应答**，
    不是代理拦截；它只是需要 key + 搜索引擎 ID（cx）。而直接抓 `google.com/search` 仍然没意义
    （302 + 反爬，与 bing 同理）。
  - 判据：以上是 2026-08-07 用 `curl -o /dev/null -w '%{http_code}'` 逐个实测的结果 ——
    **返回任意 HTTP 状态码就算连通**（401/403/404/405 都是通，只是缺鉴权或路径不对），
    `000` 才是被挡。怀疑某个域名时照这个方法复测，不要凭印象改这份清单。

## 引用要求

联网得到的结论必须给出来源链接。检索结果里的 URL 可直接引用，不必再打开确认。
