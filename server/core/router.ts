import type { BaseAgent } from "../agents/base-agent.js";
import { config } from "../config/index.js";
import { resolveProvider } from "../config/provider-env.js";
import { getRuntime } from "../runtime/index.js";
import { employeeDisplayName } from "../boss/persona.js";

export interface RouteResult {
  agent: BaseAgent;
  /** 从用户输入中提取的入参（对应 agent.paramsSchema / routePatterns 命名捕获组） */
  params: Record<string, unknown>;
  via: "pattern" | "mention" | "llm" | "fallback" | "clarify";
  /** via=clarify 时：路由器拿不准，需要先向用户确认的问题（agent 为暂定的最佳猜测） */
  clarify?: string;
}

/**
 * 没有任何候选的职责覆盖这件活。
 *
 * 这个出口是必须的：路由器若永远得交出一个人，「名册里没人能干」就永远表达不出来，
 * 而那正是招临时工的唯一触发条件（见 boss/temp-worker.ts）。缺了它，未知领域的活
 * 只会被塞给最像的那个人或兜底岗，临时工机制形同废置。
 */
export interface NoFit {
  via: "none";
  reason: string;
}

export type RouteOutcome = RouteResult | NoFit;

/**
 * 轻量 LLM 路由器：从候选 agent 中选择一个，并提取其所需入参。
 * 决策顺序：候选仅 1 个 → 直接返回；命中 routePatterns → 直接返回（零 LLM）；
 * 否则一次轻量 LLM 调用同时完成分类 + 参数提取。
 *
 * 两种「交不出人」的情形，语义**刻意分开**：
 * - `via:"none"`（NoFit）：模型判定没有任何候选的职责覆盖这件活 → 上层该现招临时工。
 * - `via:"fallback"`：模型输出坏了（返回了不存在的名字），退给显式声明 routeFallback
 *   的岗位。这是技术兜底，不代表「这活归他」。没人声明兜底岗时也返回 NoFit——
 *   随手抓 candidates[0] 会把活交给名单里恰好排第一的岗位（当前是招聘岗 hr）。
 */
export async function routeAgent(
  prompt: string,
  candidates: BaseAgent[],
): Promise<RouteOutcome> {
  if (candidates.length === 0) throw new Error("routeAgent: 候选 agent 为空");
  const declaredFallback = candidates.find((a) => a.routeFallback);
  // 只有一个候选时不问模型（零 LLM 快速通道）：判不判「合不合适」都只有这一个答案
  if (candidates.length === 1) return { agent: candidates[0], params: {}, via: "fallback" };

  // 1) 规则快速通道：命名捕获组直接成为 params
  for (const agent of candidates) {
    for (const pattern of agent.routePatterns ?? []) {
      const match = prompt.match(pattern);
      if (match) {
        return { agent, params: { ...(match.groups ?? {}) }, via: "pattern" };
      }
    }
  }

  // 1.5) 点名快速通道：用户明确提到某位同事的花名 → 必须派他（确定性，零 LLM）。
  // 恰好点名一位时直接返回；点名多位/零位交给 LLM（prompt 里也有点名规则兜底）
  const mentioned = candidates.filter((a) => {
    const nick = employeeDisplayName(a.name);
    return nick && nick !== a.name && prompt.includes(nick);
  });
  if (mentioned.length === 1) {
    return { agent: mentioned[0], params: {}, via: "mention" };
  }

  // 2) LLM 分类 + 参数提取
  try {
    const catalog = candidates.map((a) => ({
      name: a.name,
      称呼: employeeDisplayName(a.name),
      when: a.routeHint ?? a.description,
      params: a.paramsSchema ?? {},
    }));
    const routerPrompt = [
      "你是团队主管的派工助手。根据用户输入，从候选 agent 中选一个最合适的，并按其 params 说明从输入中提取入参。",
      `候选 agent（when = 各自的职责边界，严格按它判断）：${JSON.stringify(catalog, null, 2)}`,
      "## 派工原则",
      "- **点名最高优先**：用户点名让某位同事做（用「称呼」或 name，如『让小码看下』），**必须选他**，不得改派；点名的人不在候选里才按意图正常派工。",
      "- **看意图，不看表面信号**：出现 git 地址不代表要代码评审——要结合用户想干什么（修 bug？查原因？审质量？问问题？）。",
      "- **用户报了一个 bug/问题**：默认诉求是「修好它」（编码实现类），除非用户明确说只要定位原因/排查、或给的是线上告警与日志。",
      "- **只有用户明确要「评审/CR/代码质量审查」**才派评审类；明确要「排查/定位/根因」才派诊断类。",
      "- **多个候选都说得通、且派错代价不小**（如「评审 vs 修复」「诊断 vs 修复」方向完全不同）：不要硬猜，走 clarify 向用户确认。日常小事（问答类）不必 clarify。",
      "- **没有任何候选的职责边界覆盖这件活** → 输出 none，说清缺的是什么能力。团队会为它现招一个临时工，这比硬塞给最像的那个人好得多。",
      "  · 判据是**职责边界**，不是难度：活难、活大、跨了两三个领域，都不是 none 的理由（那些该选人或 clarify）。",
      "  · 反过来也不要为了「总得有个人」而硬凑：候选的【选我当】都对不上、只能靠【别选我当】的反面去附会时，就是 none。",
      "## 输出（只输出 JSON）",
      '拿得准：{"agent":"<候选name>","params":{...},"confidence":"high"}',
      '拿不准：{"agent":"<最佳猜测name>","params":{...},"confidence":"low","clarify":"<向用户确认的问题：一句话点明歧义 + 给出可选方向>"}',
      '没人合适：{"agent":"none","reason":"<这活需要什么能力，而名册里谁都不覆盖>"}',
      "无法提取的字段省略，params 可为 {}。",
      `用户输入：${prompt}`,
    ].join("\n\n");

    let text = "";
    const prov = resolveProvider({ id: config.boss.providerId, model: config.boss.model });
    const model =
      config.boss.model ??
      config.routerModel ??
      prov.providerDefaultModel ??
      config.model;
    const result = await getRuntime().complete({
      prompt: routerPrompt,
      model,
      cwd: config.workingDir,
      env: prov.env as Record<string, string>,
    });
    text = result.text;

    const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
    const parsed = jsonText
      ? (JSON.parse(jsonText) as {
          agent?: string;
          params?: Record<string, unknown>;
          confidence?: string;
          clarify?: string;
          reason?: string;
        })
      : undefined;
    if (parsed?.agent === "none") {
      return { via: "none", reason: parsed.reason?.trim() || "名册里没有职责覆盖这件活的同事" };
    }
    const agent = candidates.find((a) => a.name === parsed?.agent);
    if (agent) {
      if (parsed?.confidence === "low" && parsed.clarify?.trim()) {
        return { agent, params: parsed.params ?? {}, via: "clarify", clarify: parsed.clarify.trim() };
      }
      return { agent, params: parsed?.params ?? {}, via: "llm" };
    }
    console.warn(`[router] 模型返回了不存在的候选：${String(parsed?.agent)}`);
  } catch (error) {
    const e = error as { message?: string; statusCode?: number; responseBody?: string };
    const detail = e.responseBody || e.message || String(error);
    const status = e.statusCode ? `[${e.statusCode}] ` : "";
    console.error("[router] LLM 路由失败:", status + detail);
    throw new Error(`路由失败：${status}${detail.slice(0, 200)}`);
  }

  if (declaredFallback) return { agent: declaredFallback, params: {}, via: "fallback" };
  return { via: "none", reason: "模型没给出可用候选，且团队里没有声明兜底岗位" };
}
