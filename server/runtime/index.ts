import { config } from "../config/index.js";
import type { AgentRuntime, RuntimeKind } from "./types.js";
import { VercelRuntime } from "./vercel-runtime.js";
import { QoderRuntime } from "./qoder-runtime.js";

/**
 * 按 kind 缓存的 runtime 实例。
 *
 * 为什么按 kind 分键而不是单个变量：runtime 由启动参数 --runtime 选定（全局），
 * 但夹具会在同一进程里切换验证「选择逻辑」本身，单变量会让上一次的实例串味。
 * 各 kind 仍是懒加载单例——真正建实例才会触到对应 SDK。
 */
const instances = new Map<RuntimeKind, AgentRuntime>();

/** 夹具注入的替身：一旦设置，优先于按 kind 的解析（见 setRuntime） */
let _override: AgentRuntime | undefined;

function createRuntime(kind: RuntimeKind): AgentRuntime {
  switch (kind) {
    case "qoder":
      return new QoderRuntime();
    case "vercel":
    default:
      return new VercelRuntime();
  }
}

export function getRuntime(): AgentRuntime {
  if (_override) return _override;
  const kind = config.runtimeKind;
  let inst = instances.get(kind);
  if (!inst) {
    inst = createRuntime(kind);
    instances.set(kind, inst);
  }
  return inst;
}

/**
 * 注入替身 runtime。**仅供 __fixtures__ 使用**，生产代码不要调用。
 *
 * 存在理由：像「空输出守卫」这类逻辑的 bug 是**不可达**（守卫排在 throw 之后，永远执行不到），
 * 这种缺陷跑真模型是测不出来的——真模型大概率不会恰好空输出。用假 runtime 回放
 * 一段确定的事件序列，才能把「守卫到底有没有被执行」变成一条断言。
 *
 * 传 undefined 可撤销注入，让 getRuntime() 回到按 kind 解析（夹具间互不污染）。
 */
export function setRuntime(runtime: AgentRuntime | undefined): void {
  _override = runtime;
}

export type { AgentRuntime, RuntimeRunInput, RuntimeCompleteInput, RuntimeCompleteResult, RuntimeEvent, RuntimeKind } from "./types.js";
