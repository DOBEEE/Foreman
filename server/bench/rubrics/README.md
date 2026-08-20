# agent-service rubric

这套 rubric 只用于 `target.adapter: http-agent-service`（`suite.evaluator: agent-service`），
被测对象是常驻服务里的员工 Agent：接收一句提问、多轮工具调用、给出文本答复。

与 `assets/judges/`（AIT 页面生成）分目录存放的原因：`judge` fingerprint 是整个 rubric
目录的内容哈希，混在一起会让任一侧新增文件把另一侧的基线全判 `incompatible_fingerprint`。

## 与 AIT rubric 的差异

删掉了本形态不存在的前置要求，否则四维会稳定返回 `invalid`：

| 维度 | 删除/改动 |
|---|---|
| tool | 删除 `origin=global-contract` 与 `knowledge-consumption.json` / `tool-execution.json` 契约表（foreman 没有 Command 契约）；`trace.messages` 换成轨迹里的 `kind:"text"` 行 |
| convention | 删除 `contracts.knowledge 与被测 Command 一致`；`runtime.gates/playwright` 为 `not_applicable` 视为合法 |
| recovery | `runtime.*` 可读改为 `not_applicable` 合法；最终状态改用后续工具结果 + completion 断言结果 |
| hallucination | `truthSources.prd` 语义改为「提问原文」；事实源改为 requirements 冻结事实 + 知识库 ruleText + 工具实际返回内容 |

## completion 不由 judge 评

`completion` 是自进化门禁的**主项**，必须零 LLM —— 让同一模型家族既当被测又当裁判，
误差方向系统性相关，门禁就是摆设。它由 `src/evaluation/trace-assertions.ts` 的确定性
断言引擎算出，规则如下：

- 只有 `scoring` 含 `'completion'` 的断言进分母；
- `deterministicStatus === 'pass'` 计通过；
- **`needs_judge` 在 completion 里一律计不通过** —— 不能把不确定交给 judge。因此
  completion 断言在 case 里应写 `allowEquivalent: false`；
- `not_applicable` 不入分母（如 `order` 断言的 after 侧压根没发生、`scope` 断言本次没有
  带路径入参的调用）；
- **分母为 0 → `status: 'invalid'`**，不是满分：那说明 case 没声明任何可判定断言，是 case 写错了，
  必须显式暴露；
- `aggregateMetrics` 要求同一 case 的 N 次运行**每次 rate 都为 1** 才算该 case 通过。

断言结果同时以 `deterministicStatus` 回填进 `evidence.trace.assertions`，作为 tool judge
决策树的入口 —— 一套引擎两处用，不引入第二套 DSL。

## 门禁判据

completion 只是必要条件：答得对不对由 hallucination 承担。所以门禁应是
**「completion 不退化 且 hallucination 不上升」**，而不是「completion 达到某个分数」。
`src/repair/evolve.ts` 的 `candidateVerdict` 已经是这个语义。
