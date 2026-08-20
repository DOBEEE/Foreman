import type { AgentOptions } from "../../types/agent-options.js";
import type { AgentProfile } from "../../config/agent-profile.js";
import { TEMP_DEFAULT_TOOLS } from "../../tools/catalog.js";
import { BaseAgent } from "../base-agent.js";
import type { TempWorkerSpec } from "./types.js";

/**
 * 临时工（编队补位工）：组长在 plan 里现场定义的一次性执行者，用完即弃。
 * 与「员工」的区别是刻意的——临时工**没有** profile 文件、没有经验库、不参与复盘、
 * 不占员工槽位，也不能当评审人。适合无人负责的辅助活（检索/汇总/格式转换/跑脚本）。
 * 工具上不设限于只读（默认可写可执行，见 TEMP_DEFAULT_TOOLS），否则能干的事太有限；
 * 全局门禁（主干保护、经验库只读、审计）照常生效。
 *
 * 实现上就是一个 profile 由内存注入的 BaseAgent：审计、门禁、编队协议注入等
 * 全套机制照常生效（工作目录由执行器传入的编队共享 cwd 决定）。
 */
export class EphemeralAgent extends BaseAgent {
  readonly name: string;
  private readonly injected: AgentProfile;

  constructor(stepId: string, spec: TempWorkerSpec) {
    super();
    // 名字带 temp: 前缀，日志/trace 里一眼可辨（不与任何注册员工冲突）
    this.name = `temp:${stepId}`;
    this.injected = {
      id: this.name,
      displayName: spec.role ?? "临时工",
      description: spec.role ?? "编队临时补位工",
      type: "simple",
      systemPrompt: spec.prompt ?? `你是编队里的临时协助人员：${spec.role ?? "按指令完成一项辅助工作"}。`,
      // 默认可读写可执行命令（不含 Task）；组长可用 temp.tools 显式收窄
      tools: spec.tools?.length ? [...spec.tools] : [...TEMP_DEFAULT_TOOLS],
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
      source: "hired",
    };
  }

  override get profile(): AgentProfile {
    return this.injected;
  }

  /** 无自有工作目录：始终跑在执行器传入的编队共享目录里 */
  protected override resolveCwd(): string {
    return process.cwd();
  }

  override buildOptions(input: Parameters<BaseAgent["buildOptions"]>[0]): AgentOptions & { protocolTools?: Record<string, unknown> } {
    return super.buildOptions(input);
  }
}
