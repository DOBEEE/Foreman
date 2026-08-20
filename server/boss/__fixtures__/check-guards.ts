/**
 * 工具门禁（ToolGuard）的结构性校验（零 LLM，纯断言）。
 *
 * 为什么必须专测：这一层曾经**整层失效**——策略是按 claude-agent-sdk 的 hook 形状写的，
 * 而 runtime 换成 Vercel AI SDK 后没有 hook 执行点，`options.guards` 更是全代码库无人赋值。
 * 结果是「只读岗位」照样能跑 Bash、能调未授权的 MCP 工具。
 * 一个门禁失效时**不会报错、只会静默放行**，所以只能靠断言钉住。
 *
 * 这里同时验两层：
 * 1. 单个 guard 的判定逻辑（deny / allow）
 * 2. applyGuards 真的包住了 execute（不然逻辑对了也没用）
 *
 * 用法：npx tsx server/boss/__fixtures__/check-guards.ts
 */

import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { config } from "../../config/index.js";
import { getAgent } from "../../agents/registry.js";
import { applyGuards, type ToolGuard } from "../../runtime/hooks.js";
import {
  buildBranchGuard,
  buildMcpScopeGuard,
  buildMemoryOffGuard,
  buildMemoryScopeGuard,
  buildNotesScopeGuard,
  buildReadRootsGuard,
  isPushToProtected,
  mcpToolAllowed,
  splitMcpPatterns,
} from "../../core/audit.js";
import { MEMORY_ROOT } from "../../core/memory.js";
import { notesDirOf } from "../../core/notes.js";

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

/** 跑一个 guard，返回是否被拦 */
async function denied(guard: ToolGuard, toolName: string, input: Record<string, unknown>) {
  const r = await guard(toolName, input);
  return "deny" in r && r.deny === true;
}

const CWD = join(config.workspacesRoot, "fixture-guard");

async function main(): Promise<void> {
  process.stdout.write("\n── applyGuards 真的包住了 execute ──\n");
  // 这条是整层的地基：guard 逻辑再对，没被接上就等于没有
  let executed = false;
  const bag = applyGuards(
    {
      Bash: tool({
        description: "t",
        inputSchema: z.object({ command: z.string() }),
        execute: async () => {
          executed = true;
          return "ran";
        },
      }),
    },
    [async () => ({ deny: true as const, reason: "测试拦截" })],
  );
  const out = await (bag.Bash as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
    command: "echo hi",
  });
  check("被拦时不执行原 execute", !executed);
  check("拦截原因回给模型", String(out).includes("[BLOCKED]") && String(out).includes("测试拦截"), String(out));

  process.stdout.write("\n── 主干保护（Bash git push）──\n");
  const branch = buildBranchGuard("fixture");
  check("push master 被拦", await denied(branch, "Bash", { command: "git push origin master" }));
  check("push HEAD:main 被拦", await denied(branch, "Bash", { command: "git push origin HEAD:main" }));
  check("--force push main 被拦", await denied(branch, "Bash", { command: "git push --force origin main" }));
  check("裸 push 被保守拦下", await denied(branch, "Bash", { command: "git push" }));
  check("多 refspec 里夹带 master 被拦", isPushToProtected("git push origin feat/x master"));
  check("push 工作分支放行", !(await denied(branch, "Bash", { command: "git push origin feat/x" })));
  check("非 push 命令不管", !(await denied(branch, "Bash", { command: "git status" })));
  check("其它工具不管", !(await denied(branch, "Read", { file_path: "/tmp/a" })));

  process.stdout.write("\n── 文件范围门禁（readRoots）──\n");
  const roots = buildReadRootsGuard("fixture", CWD, [CWD, config.knowledgeDir], [CWD]);
  check("读白名单内放行", !(await denied(roots, "Read", { file_path: join(config.knowledgeDir, "a.md") })));
  check("读越界被拦", await denied(roots, "Read", { file_path: "/etc/hosts" }));
  check("写工作目录放行", !(await denied(roots, "Write", { file_path: join(CWD, "out.md") })));
  check(
    "写检索源被拦（只读岗拿到 Write 也不能污染知识库）",
    await denied(roots, "Write", { file_path: join(config.knowledgeDir, "a.md") }),
  );
  check(
    "白名单内的 .env 也被拦",
    await denied(roots, "Read", { file_path: join(config.knowledgeDir, ".env") }),
  );
  // 本轮新增：给了 Bash 就必须连 Bash 里的路径一起管，否则围栏旁边留着一道门
  check(
    "Bash 越界重定向被拦",
    await denied(roots, "Bash", { command: "echo x > /Users/other/hack.txt" }),
  );
  check("Bash rm 越界被拦", await denied(roots, "Bash", { command: "rm -rf /Users/other/repo" }));
  check(
    "Bash 写自己工作目录放行",
    !(await denied(roots, "Bash", { command: `echo x > ${join(CWD, "a.txt")}` })),
  );
  check(
    "Bash 纯读不做 roots 校验（避免误杀 /usr/bin 这类系统路径）",
    !(await denied(roots, "Bash", { command: "/usr/bin/env node -v" })),
  );
  check(
    "Bash 纯读仍拦凭据",
    await denied(roots, "Bash", { command: "cat ~/.ssh/id_rsa" }),
  );
  // 实测踩到过的误判：awk / test 表达式里的 `>` 与重定向同形，会把纯读命令判成越界写
  check(
    "引号内的 > 不算重定向（awk 'NR>1' 不该被当成写）",
    !(await denied(roots, "Bash", {
      command: `cd ${config.knowledgeDir} && awk -F, 'NR>1 {s+=$2} END {print s}' a.csv`,
    })),
  );
  check(
    "引号内的 > 也不影响 test 表达式",
    !(await denied(roots, "Bash", { command: `wc -l < ${join(config.knowledgeDir, "a.md")}` })),
  );
  check(
    "引号外的重定向照抓",
    await denied(roots, "Bash", { command: "awk 'NR>1' a.csv > /Users/other/out.csv" }),
  );
  check(
    "2>&1 不算写文件",
    !(await denied(roots, "Bash", { command: "node -v 2>&1" })),
  );
  // benchmark 实测抓到的误判：只读岗位用 `grep ... 2>/dev/null` 读知识库被判成写入，
  // 走 writeRoots 校验后被拒，还报出误导性的「拒绝写入」
  check(
    "2>/dev/null 不算写文件（只读检索的惯用写法）",
    !(await denied(roots, "Bash", {
      command: `grep -rn memory ${config.knowledgeDir} 2>/dev/null`,
    })),
  );
  check(
    ">/dev/null 2>&1 不算写文件",
    !(await denied(roots, "Bash", {
      command: `grep -rn memory ${config.knowledgeDir} >/dev/null 2>&1`,
    })),
  );
  check(
    "/dev/nullx 是真实文件名，越界仍要拦（别把排除放宽成前缀匹配）",
    await denied(roots, "Bash", { command: "echo x > /Users/other/dev/nullx" }),
  );
  // 线上事故 #c76020：命令里只要有写动作，旧实现就把命令里**所有**路径按 writeRoots 校验，
  // 于是「执行只读的技能脚本 + 输出落到工作目录」被报成「拒绝写入那个脚本」。
  // 连挡三次，员工整轮预算耗在跟门禁较劲上，拒绝文案指向的还是无辜路径。
  check(
    "执行检索源里的只读脚本、输出落工作目录 → 放行",
    !(await denied(roots, "Bash", {
      command: `bash ${join(config.knowledgeDir, "scripts", "fetch.sh")} doc/x > raw/out.txt`,
    })),
  );
  check(
    "写动作与只读读取同命令 → 只读那侧不按 writeRoots 校验",
    !(await denied(roots, "Bash", {
      command: `mkdir -p raw && cat ${join(config.knowledgeDir, "a.md")} > raw/a.md`,
    })),
  );
  check(
    "cp 的来源是只读引用，只有目的地算写目标",
    !(await denied(roots, "Bash", {
      command: `cp ${join(config.knowledgeDir, "a.md")} ${join(CWD, "a.md")}`,
    })),
  );
  check(
    "cp 目的地越界仍要拦",
    await denied(roots, "Bash", {
      command: `cp ${join(config.knowledgeDir, "a.md")} /Users/other/a.md`,
    }),
  );
  check(
    "引号包裹的越界重定向目标仍要拦（分词要能从引号里取出目标）",
    await denied(roots, "Bash", { command: `echo x > "/Users/other/has space.txt"` }),
  );
  check(
    "相对路径的越界重定向被拦（按本次 run 的 cwd 解析）",
    await denied(roots, "Bash", { command: "echo x > ../../../../../../tmp/hack.txt" }),
  );

  process.stdout.write("\n── 笔记 / 经验库范围 ──\n");
  const notes = buildNotesScopeGuard("alice");
  check("写自己的笔记放行", !(await denied(notes, "Write", { file_path: join(notesDirOf("alice"), "n.md") })));
  check("写别人的笔记被拦", await denied(notes, "Write", { file_path: join(notesDirOf("bob"), "n.md") }));
  const memRo = buildMemoryScopeGuard("fixture");
  check("常规运行写经验库被拦", await denied(memRo, "Write", { file_path: join(MEMORY_ROOT, "alice", "m.md") }));
  const memRetro = buildMemoryScopeGuard("fixture", "alice");
  check("复盘可写自己那份", !(await denied(memRetro, "Write", { file_path: join(MEMORY_ROOT, "alice", "m.md") })));
  check("复盘不得写别人那份", await denied(memRetro, "Write", { file_path: join(MEMORY_ROOT, "bob", "m.md") }));
  // 实测事故：复盘员工在 A 的轮次里用 `cat > memory/B/index.md` 覆写了 B 的经验索引，
  // 门禁一声没响——因为它只认 Write/Edit。有 Bash 的岗位，围栏旁边就是一道门。
  check(
    "Bash 重定向写别人的经验库被拦",
    await denied(memRetro, "Bash", {
      command: `cat > ${join(MEMORY_ROOT, "bob", "index.md")} <<'EOF'\nx\nEOF`,
    }),
  );
  check(
    "Bash 追加写别人的经验库被拦",
    await denied(memRetro, "Bash", {
      command: `echo x >> ${join(MEMORY_ROOT, "bob", "topics", "topic-1.md")}`,
    }),
  );
  check(
    "Bash 写自己那份放行",
    !(await denied(memRetro, "Bash", { command: `cat > ${join(MEMORY_ROOT, "alice", "index.md")}` })),
  );
  check(
    "Bash 只读别人的经验库不拦（复盘要跨岗位取证）",
    !(await denied(memRetro, "Bash", { command: `cat ${join(MEMORY_ROOT, "bob", "index.md")}` })),
  );
  check(
    "Bash 写别人的笔记被拦",
    await denied(notes, "Bash", { command: `cat > ${join(notesDirOf("bob"), "n.md")}` }),
  );
  // 拒绝原因必须指出是哪条路径被拒：不说路径，模型分不清「我写错了目标」和「门禁坏了」，
  // 实测复盘员工就此把正常拦截误报成系统 bug，连报三轮并一路捅到用户面前。
  const denyReason = await memRetro("Write", { file_path: join(MEMORY_ROOT, "bob", "m.md") });
  const reasonText = "deny" in denyReason ? denyReason.reason : "";
  check("拒绝原因带上被拒路径", reasonText.includes(join(MEMORY_ROOT, "bob", "m.md")), reasonText);
  check("拒绝原因带上放行范围", reasonText.includes(join(MEMORY_ROOT, "alice")), reasonText);
  // 目录边界：裸 startsWith 会让 alice 的放行范围顺带覆盖 alice-backup
  check(
    "相邻同前缀目录不被误放行",
    await denied(memRetro, "Write", { file_path: join(MEMORY_ROOT, "alice-backup", "m.md") }),
  );
  const memOff = buildMemoryOffGuard("fixture");
  check(
    "MEMORY=off 时拦 SDK 记忆目录",
    await denied(memOff, "Read", { file_path: "/Users/x/.claude/projects/p/memory/x.md" }),
  );

  process.stdout.write("\n── applyGuards 不得污染共享 tool 对象 ──\n");
  /**
   * 实测事故：Read/Write/Bash 这些内置 tool 是模块级单例，而 applyGuards 曾经
   * `{...tools}` 浅拷贝后就地改 `.execute`，于是每跑一次 run 就在同一个对象上永久叠一层
   * （新层在外、旧层在内）。
   * 后果一：一次调用把历史每层都跑一遍，实测单次 Read 被审计记了 18 行。
   * 后果二：任一层 deny 即拦——本轮那层放行了、上一轮那层照旧拦，报错里带的是上一轮的
   *        放行范围。复盘员工据此连报三轮「写门禁绑错岗位」的假 bug，还改用 Bash 绕过。
   */
  const shared = {
    Read: tool({
      description: "t",
      inputSchema: z.object({ file_path: z.string() }),
      execute: async () => "ran",
    }),
  };
  const originalExecute = (shared.Read as unknown as { execute: unknown }).execute;
  let firstGuardCalls = 0;
  const bagA = applyGuards(shared, [
    async () => {
      firstGuardCalls++;
      return { allow: true as const };
    },
  ]);
  const bagB = applyGuards(shared, [async () => ({ deny: true as const, reason: "B 的门禁" })]);
  check(
    "包装后原 tool 对象未被改写",
    (shared.Read as unknown as { execute: unknown }).execute === originalExecute,
  );
  const outB = await (bagB.Read as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
    file_path: "/tmp/a",
  });
  check("第二次包装只跑自己的 guard", String(outB).includes("B 的门禁"), String(outB));
  check("上一次包装的 guard 没被带进来", firstGuardCalls === 0, `firstGuardCalls=${firstGuardCalls}`);
  const outA = await (bagA.Read as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
    file_path: "/tmp/a",
  });
  check("先包装的那份不受后包装影响", outA === "ran" && firstGuardCalls === 1, String(outA));

  process.stdout.write("\n── MCP 授权范围 ──\n");
  const mcp = buildMcpScopeGuard("fixture", ["mcp__yuque", "mcp__code__get_file_blame"]);
  check("server 级放行整个 server", !(await denied(mcp, "mcp__yuque__whoami", {})));
  check("工具级精确放行", !(await denied(mcp, "mcp__code__get_file_blame", {})));
  check("同 server 的其它工具被拦", await denied(mcp, "mcp__code__edit_repo_files", {}));
  check("未点名的 server 被拦", await denied(mcp, "mcp__chrome__navigate_page", {}));
  check("内置工具不受 MCP 门禁影响", !(await denied(mcp, "Read", { file_path: "/tmp/a" })));
  // 注册期过滤走同一套判定：一处规则两处用，不会各自漂移
  const scope = splitMcpPatterns(["mcp__yuque"]);
  check("注册期过滤：授权的留下", mcpToolAllowed("mcp__yuque__read", scope));
  check("注册期过滤：未授权的剔掉", !mcpToolAllowed("mcp__chrome__click", scope));
  check("注册期过滤：非 MCP 一律留下", mcpToolAllowed("Read", scope));
  const denyAll = splitMcpPatterns([]);
  check(
    "声明了 tools 但没点名任何 MCP = 全不授权（不是全放行）",
    !mcpToolAllowed("mcp__yuque__read", denyAll),
  );

  process.stdout.write("\n── 接线：guards 真的到了 options 里 ──\n");
  // 这一条防的是「策略都写对了，但 buildOptions 没把它交出去」——本轮修的正是这个
  const agent = getAgent("hr");
  const opts = agent
    ? (agent as unknown as { buildOptions: (i: unknown) => Record<string, unknown> }).buildOptions({
        prompt: "x",
        params: {},
      })
    : {};
  const guards = (opts.guards ?? []) as ToolGuard[];
  check("buildOptions 产出非空 guards", guards.length > 0, String(guards.length));
  check("内置工具白名单也交出去了（runtime 据此裁剪工具袋）", Array.isArray(opts.tools));
  check("MCP 授权范围随之交出", Array.isArray(opts.mcpAllow));
  // hr 只声明了 Read/Glob，且 readRoots 限于员工配置与归档目录
  const hrBlocked = await Promise.all(
    guards.map((g) => g("Bash", { command: "rm -rf /tmp/x" })),
  );
  check(
    "hr 的 guards 链能拦下越界写（逐条跑，任一 deny 即拦）",
    hrBlocked.some((r) => "deny" in r && r.deny),
  );

  report();
}

function report(): void {
  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

void main();
