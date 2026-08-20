import { join } from "node:path";
import { getAgent } from "../agents/registry.js";
import { collectRunWithTrace } from "../core/runner.js";
import { sha256, writeJson } from "./files.js";
import { extractJson, judgeRuntimePrompt, validateJudgeOutput } from "./judge-contract.js";
import { hashTree } from "./files.js";
import { materializeJudgeInput, restoreMaterializedPaths } from "./materializer.js";
import type { JudgeExecutor, JudgeInput, JudgeResult, RunPaths } from "./types.js";

/**
 * 进程内评测师。
 *
 * 取代 agent-bench 那条 HTTP 路径。差别不只是少一跳网络——`/api/bench` 端点必须接受
 * 调用方指定的 `workspace` 并当 cwd 用，那是一个「任意目录写入」的攻击面，
 * 当时只能靠 token + 仅回环 + 不放行同网段来围。搬进进程内后这个面直接消失。
 *
 * 独立性不来自进程隔离（评测师和被测员工本来就同进程、同模型），而来自四条：
 *   1. 评测师岗位 `promptFrozen: true`，提示词不接受优化提案
 *   2. 工具白名单只有 Read/Glob/Grep，且 readRoots 把可读范围收到证据副本内
 *   3. 判定前后对物化目录 hashTree 比对——改了证据整份判定作废
 *   4. 输出必须带可定位引文（validateEvidenceReferences），编造路径会被抓
 *
 * 还有一条同族防线：判定前必须发生过工具调用。评测师没读任何证据就给结论，
 * 那结论必然是凭空生成的（实测撞见过「有回复、零工具调用、报 success」的形态）。
 */
export const JUDGE_AGENT_ID = "judge";

/** 评测口径的语义版本，进 evaluator 指纹；改动判定契约或 rubric 语义时递增 */
export const JUDGE_REVISION = "judge-1";

export class InProcessJudge implements JudgeExecutor {
  constructor(private readonly maxRetries = 1) {}

  async evaluate(paths: RunPaths, input: JudgeInput): Promise<JudgeResult> {
    const transcriptFile = join(paths.judge, `${input.metric}.judge.json`);
    const requestFingerprint = sha256(
      JSON.stringify({
        metric: input.metric,
        rubric: input.rubric,
        evidence: input.evidence,
        schema: input.outputSchema,
        revision: JUDGE_REVISION,
      }),
    );
    const agent = getAgent(JUDGE_AGENT_ID);
    if (!agent) {
      return {
        metric: input.metric,
        status: "error",
        error: `评测师岗位 ${JUDGE_AGENT_ID} 未注册`,
        transcriptFile,
        requestFingerprint,
      };
    }

    let lastError = "";
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const materialized = materializeJudgeInput(paths, input);
      const before = hashTree(materialized.workspace);
      try {
        const collected = await collectRunWithTrace(
          agent.run({
            prompt: judgeRuntimePrompt(input),
            cwd: materialized.workspace,
            // 评测师不注入经验库：判据必须只来自 rubric 与封存 oracle，
            // 让它带着「上次怎么判的」进来会把口径变成会漂移的东西
            memory: "off",
            params: { channel: "bench", chatType: "private", senderName: "bench" },
          }),
        );
        const after = hashTree(materialized.workspace);
        writeJson(transcriptFile, {
          schemaVersion: 1,
          attempt,
          metric: input.metric,
          summary: collected.summary,
          lines: collected.lines,
          workspaceHash: { before, after },
        });

        if (collected.summary?.isError) {
          throw new Error(`评测师执行失败: ${String(collected.summary.result ?? "").slice(0, 400)}`);
        }
        if (!collected.toolCalls.length) {
          throw new Error("评测师未发生任何工具调用，说明它没有真的读证据");
        }
        if (before !== after) {
          throw new Error("评测师修改了只读评测工作目录，结果无效");
        }
        const materializedOutput = extractJson(collected.text);
        validateJudgeOutput(input, materializedOutput, materialized.workspace);
        const output = restoreMaterializedPaths(materializedOutput, materialized.pathMap) as Record<
          string,
          unknown
        >;
        return { metric: input.metric, status: "completed", output, transcriptFile, requestFingerprint };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        writeJson(transcriptFile, { schemaVersion: 1, attempt, metric: input.metric, error: lastError });
      }
    }
    return { metric: input.metric, status: "error", error: lastError, transcriptFile, requestFingerprint };
  }
}
