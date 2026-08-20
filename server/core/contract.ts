import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 产出合约：声明一次任务/步骤「做完了应该留下什么」，用来把验收从「读模型自述」
 * 变成「查客观事实」。
 *
 * 为什么必须有这一层：boss 和组长的轻量验收都是**单轮无工具**的文本判断，
 * 员工写一句「已写入 xxx.md」它就只能信。实测复盘员工声称落盘、实际被门禁拦下的
 * 情况出现过多轮，而验收全程没察觉。文件在不在是 `fs` 一次调用就能定论的事，
 * 不该交给模型猜。
 *
 * 分工：`files` 完全确定性（本模块自带）；`data` 需要从结论文本里提取语义字段，
 * 必须由调用方注入提取器（见 `ContractDataExtractor`）——本模块不引入任何模型依赖，
 * 这样零成本的那一半可以被任何地方放心复用。
 */
export interface Contract {
  /** 必须存在的文件（相对 cwd），支持 glob 如 "src/*.ts" */
  files?: string[];
  /**
   * 必须在结论中包含的结构化数据字段。
   * key = 字段名（下游通过 {{step:id.key}} 引用）；value = 字段含义描述（供 LLM 提取）。
   * 示例：{ "entryFile": "入口文件路径", "testCommand": "运行测试的命令" }
   */
  data?: Record<string, string>;
}

/** 从结论文本里提取合约声明字段的实现（需要模型，由调用方注入） */
export type ContractDataExtractor = (
  schema: Record<string, string>,
  output: string,
  cwd: string,
) => Promise<Record<string, string>>;

/** 文件是否存在：支持 * / ** glob（用 fs 递归匹配，不引第三方依赖） */
export function fileMatches(pattern: string, cwd: string): boolean {
  if (!pattern.includes("*")) return existsSync(join(cwd, pattern));
  // glob → 正则：** 跨目录，* 单层
  const rx = new RegExp(
    `^${pattern
      .split("/")
      .map((seg) =>
        seg === "**" ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
      )
      .join("/")
      .replace(/\.\*\//g, "(?:.*/)?")}$`,
  );
  const walk = (dir: string, rel: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${name}` : name;
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (walk(full, relPath)) return true;
      } else if (rx.test(relPath)) {
        return true;
      }
    }
    return false;
  };
  return walk(cwd, "");
}

/**
 * 只查文件产物的那一半：**零模型调用、零网络**，可以在任何终态路径上白跑。
 * 返回缺失项描述清单（空 = 声明的文件都在）。
 */
export function missingContractFiles(contract: Contract, cwd: string): string[] {
  return (contract.files ?? [])
    .filter((pattern) => !fileMatches(pattern, cwd))
    .map((pattern) => `文件 ${pattern}（不存在）`);
}

/**
 * 完整合约校验：文件用 fs 硬查（确定性），数据字段用注入的提取器（需要模型）。
 * 未注入提取器时**跳过**数据字段而不是判缺失——否则零成本调用方会凭空判所有任务失败。
 * 返回缺失项清单（空 = 合约满足）。
 */
export async function validateContract(
  contract: Contract,
  output: string,
  cwd: string,
  extractData?: ContractDataExtractor,
): Promise<{ pass: boolean; missing: string[]; extracted: Record<string, string> }> {
  const missing = missingContractFiles(contract, cwd);

  let extracted: Record<string, string> = {};
  const fields = Object.entries(contract.data ?? {});
  if (fields.length > 0 && extractData) {
    extracted = await extractData(contract.data!, output, cwd);
    for (const [key, desc] of fields) {
      if (!extracted[key]) missing.push(`数据字段「${key}」（${desc}）`);
    }
  }

  return { pass: missing.length === 0, missing, extracted };
}
