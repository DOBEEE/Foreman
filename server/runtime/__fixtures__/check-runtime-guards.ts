/**
 * 运行时兜底与检索工具的**可达性**断言（零 LLM）。
 *
 * 两条都是 benchmark 首轮真实跑出来的缺陷：
 * 1. 模型把工具调用 XML 吐进文本通道（0 次真实调用），运行时因 finalText 非空
 *    判为 success 交付给上层 —— 空输出兜底接不住这种形态。
 * 2. grep 工具硬依赖系统 rg，宿主没装时直接报错，模型要多烧 2-3 轮才绕到 Bash。
 *
 * 真模型跑不稳定复现，所以把判据固化成纯函数断言 + 一次真实检索。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikePseudoToolCall } from "../vercel-runtime.js";
import { buildGrepTool } from "../tools/grep.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

process.stdout.write("\n── 伪工具调用识别 ──\n");
check(
  "裸 invoke 标签判为泄漏",
  looksLikePseudoToolCall('tools\n<invoke name="Grep">\n<parameter name="p">x</parameter>\n</invoke>'),
);
check("带 antml 前缀同样识别", looksLikePseudoToolCall('<invoke name="Read">'));
check("正常回答不误判", !looksLikePseudoToolCall("走代理时只填 BASE_URL 和 AUTH_TOKEN。"));
check(
  "围栏代码块里讲语法不误判",
  !looksLikePseudoToolCall('调用格式如下：\n```xml\n<invoke name="Grep"></invoke>\n```\n就这样。'),
);
check("行内代码里提标签名不误判", !looksLikePseudoToolCall("协议里用 `<invoke>` 包住入参。"));
check(
  "未闭合围栏也按代码块处理",
  !looksLikePseudoToolCall('示例：\n```\n<invoke name="Bash">'),
);

process.stdout.write("\n── grep 工具（rg 缺失时退回系统 grep）──\n");
{
  const dir = mkdtempSync(join(tmpdir(), "grep-fixture-"));
  writeFileSync(join(dir, "a.md"), "第一行\nANTHROPIC_AUTH_TOKEN 走代理只填这个\n第三行\n");
  writeFileSync(join(dir, "b.txt"), "无关内容\n");
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "nested", "c.md"), "嵌套里的 ANTHROPIC_AUTH_TOKEN\n");
  const execute = buildGrepTool(dir).execute!;
  const call = (input: Record<string, unknown>) =>
    execute(input as never, { toolCallId: "fixture", messages: [], context: {} }) as Promise<string>;

  const hit = await call({ pattern: "ANTHROPIC_AUTH_TOKEN", path: dir });
  check("能检索到匹配行", hit.includes("ANTHROPIC_AUTH_TOKEN"), hit.slice(0, 80));
  check("匹配行带文件名与行号", /a\.md:2:/.test(hit), hit.slice(0, 80));
  check("不再返回「请 brew install ripgrep」", !hit.includes("brew install"), hit.slice(0, 80));

  const miss = await call({ pattern: "不存在的字符串xyz", path: dir });
  check("无匹配返回 No matches found.", miss === "No matches found.", miss.slice(0, 80));

  const insensitive = await call({ pattern: "anthropic_auth_token", path: dir, caseSensitive: false });
  check("caseSensitive:false 生效", insensitive.includes("ANTHROPIC_AUTH_TOKEN"), insensitive.slice(0, 80));

  const globbed = await call({ pattern: "内容", path: dir, glob: "*.txt" });
  check("glob 过滤生效", globbed.includes("b.txt") && !globbed.includes("a.md"), globbed.slice(0, 80));

  const limited = await call({ pattern: "行", path: dir, maxResults: 1 });
  check("maxResults 全局截断并留痕", limited.includes("truncated"), limited.slice(0, 120));

  // 以下两条是门禁绕过的根因：守卫按 runCwd 校验相对路径，工具必须用同一基准
  const defaulted = await call({ pattern: "ANTHROPIC_AUTH_TOKEN" });
  check(
    "path 缺省落在 run 工作目录而非进程 cwd",
    defaulted.includes("a.md") && !defaulted.includes("agent-base/server"),
    defaulted.slice(0, 100),
  );
  const relative = await call({ pattern: "ANTHROPIC_AUTH_TOKEN", path: "nested" });
  check(
    "相对 path 相对 run 工作目录解析",
    relative.includes("c.md") && !relative.includes("a.md"),
    relative.slice(0, 100),
  );
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
