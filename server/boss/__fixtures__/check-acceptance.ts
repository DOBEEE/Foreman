/**
 * 产出合约硬校验的结构性校验（零 LLM，纯断言）。
 *
 * 为什么必须专测这一层：boss 与组长的轻量验收都是**单轮无工具**的文本判断——员工写一句
 * 「已写入 xxx.md」它就只能信。实测复盘员工声称落盘、实际被写门禁拦下的情况出现过多轮，
 * 而验收全程没察觉，还对用户宣称「已验收」。文件在不在是 `fs` 一次调用能定论的事。
 *
 * 这里同时钉两件事：
 * 1. 判定本身对不对（含 glob、相邻同名、node_modules 跳过）
 * 2. **这条路径一次模型都不许调**——它的全部价值就在于零成本可白跑，一旦有人往里塞
 *    LLM 提取，就不能再挂在每个任务的终态路径上了
 *
 * 用法：npx tsx server/boss/__fixtures__/check-acceptance.ts
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fileMatches,
  missingContractFiles,
  validateContract,
  type Contract,
} from "../../core/contract.js";

let pass = 0;
const fails: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    process.stdout.write(`  ✅ ${name}\n`);
  } else {
    fails.push(name);
    process.stdout.write(`  ❌ ${name}${detail ? `：${detail}` : ""}\n`);
  }
}

const ROOT = join(tmpdir(), `ait-contract-fixture-${process.pid}`);

function seed(): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "src", "deep", "nested"), { recursive: true });
  mkdirSync(join(ROOT, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(ROOT, ".hidden"), { recursive: true });
  writeFileSync(join(ROOT, "report.md"), "x");
  writeFileSync(join(ROOT, "src", "index.ts"), "x");
  writeFileSync(join(ROOT, "src", "deep", "nested", "leaf.ts"), "x");
  writeFileSync(join(ROOT, "node_modules", "pkg", "sneaky.ts"), "x");
  writeFileSync(join(ROOT, ".hidden", "secret.ts"), "x");
}

async function main(): Promise<void> {
  seed();

  process.stdout.write("\n── 精确路径 ──\n");
  check("存在即命中", fileMatches("report.md", ROOT));
  check("不存在即未命中", !fileMatches("missing.md", ROOT));
  check("子目录精确路径", fileMatches("src/index.ts", ROOT));

  process.stdout.write("\n── glob ──\n");
  check("单层 * 命中", fileMatches("src/*.ts", ROOT));
  check("单层 * 不跨目录", !fileMatches("*.ts", ROOT));
  check("** 跨目录命中", fileMatches("src/**/*.ts", ROOT));
  check("** 命中深层", fileMatches("**/leaf.ts", ROOT));
  check("glob 无命中时为 false", !fileMatches("src/**/*.rs", ROOT));

  process.stdout.write("\n── 扫描排除 ──\n");
  // 这两条不是洁癖：node_modules 里几十万个文件会让每次终态校验卡住，
  // 而 .git / .env 这类隐藏目录本来就在敏感名单上，不该被产物校验碰
  check("不扫 node_modules", !fileMatches("**/sneaky.ts", ROOT));
  check("不扫隐藏目录", !fileMatches("**/secret.ts", ROOT));

  process.stdout.write("\n── 缺失清单 ──\n");
  check("全在时清单为空", missingContractFiles({ files: ["report.md", "src/index.ts"] }, ROOT).length === 0);
  const missing = missingContractFiles({ files: ["report.md", "nope.md", "src/**/*.rs"] }, ROOT);
  check("只列缺的那些", missing.length === 2, JSON.stringify(missing));
  check("缺失项带上模式原文", missing[0].includes("nope.md"), JSON.stringify(missing));
  check("空合约不拦", missingContractFiles({}, ROOT).length === 0);
  check("files 为空数组不拦", missingContractFiles({ files: [] }, ROOT).length === 0);

  process.stdout.write("\n── validateContract：零模型调用 ──\n");
  let extractorCalls = 0;
  const spy = async () => {
    extractorCalls++;
    return {};
  };

  const okFiles = await validateContract({ files: ["report.md"] }, "产出文本", ROOT);
  check("只声明 files 时通过", okFiles.pass, JSON.stringify(okFiles.missing));
  check("只声明 files 时不调提取器", extractorCalls === 0);

  const badFiles = await validateContract({ files: ["nope.md"] }, "我已经写好了 nope.md", ROOT);
  check("声称写了但文件不在 → 判未满足", !badFiles.pass);
  check("未满足时不调提取器（先查产物再谈语义）", extractorCalls === 0);

  // 关键：没有注入提取器时，data 字段必须**跳过**而不是判缺失——
  // 否则零成本调用方（boss 的终态硬校验）会凭空把所有声明了 data 的任务判失败
  const dataNoExtractor = await validateContract(
    { data: { entryFile: "入口文件路径" } },
    "入口是 src/index.ts",
    ROOT,
  );
  check("未注入提取器时 data 被跳过而非判缺失", dataNoExtractor.pass, JSON.stringify(dataNoExtractor.missing));
  check("跳过时也没有偷偷调模型", extractorCalls === 0);

  process.stdout.write("\n── validateContract：注入提取器（squad 用法）──\n");
  const contract: Contract = { files: ["report.md"], data: { entryFile: "入口文件路径" } };
  const hit = await validateContract(contract, "入口是 src/index.ts", ROOT, async () => {
    extractorCalls++;
    return { entryFile: "src/index.ts" };
  });
  check("提取到字段 → 通过", hit.pass, JSON.stringify(hit.missing));
  check("提取值回传给调用方（下游 {{step:id.field}} 要用）", hit.extracted.entryFile === "src/index.ts");
  check("注入后才会调提取器", extractorCalls === 1);

  const miss = await validateContract(contract, "没提入口", ROOT, spy);
  check("提取不到 → 判缺失（保守）", !miss.pass);
  check("缺失项说明是哪个字段", miss.missing.some((m) => m.includes("entryFile")), JSON.stringify(miss.missing));

  process.stdout.write("\n── 文件缺失时短路，不白花提取成本 ──\n");
  const before = extractorCalls;
  await validateContract({ files: ["nope.md"], data: { k: "v" } }, "x", ROOT, spy);
  check(
    "文件已缺失仍会跑提取器（合约需一次报全，不做短路）",
    extractorCalls === before + 1,
    `calls=${extractorCalls - before}`,
  );

  rmSync(ROOT, { recursive: true, force: true });
  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

void main();
