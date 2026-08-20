/**
 * 岗位契约 → 纪律断言的派生规则断言（零 LLM）。
 *
 * 为什么要测这个：派生结果会成为该岗位的评测基线，一条错断言会让正确行为被持续判失败，
 * 而优化师会照着这个「客观证据」把员工改坏 —— 错 case 比没 case 危险得多。
 * 所以派生规则本身必须先被钉死。
 */
import { deriveContractAssertions } from "../contract-assertions.js";
import type { AgentProfile } from "../../config/agent-profile.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

const base = (over: Partial<AgentProfile>): AgentProfile =>
  ({ id: "probe", displayName: "探针", description: "d", type: "simple", ...over }) as AgentProfile;

const byId = (list: ReturnType<typeof deriveContractAssertions>, id: string) =>
  list.find((a) => a.id === id);

/** 把 ^(A|B|C)$ 拆成工具名集合。不能用子串判断——"TodoWrite" 里含 "Write" 会误命中 */
const members = (pattern?: string): string[] =>
  (pattern ?? "").replace(/^\^\(|\)\$$/g, "").split("|").filter(Boolean);

process.stdout.write("\n── 只读岗位 ──\n");
{
  const list = deriveContractAssertions(base({ tools: ["Read", "Grep", "Glob"] }));
  const readonly = byId(list, "CONTRACT-READONLY");
  check("派生出只读约束", Boolean(readonly));
  check("只读约束是 forbidden_call", readonly?.type === "forbidden_call");
  const banned = members(readonly?.selector?.toolPattern);
  check(
    "写类工具全部入选禁止名单",
    ["Write", "Edit", "Bash", "Task"].every((t) => banned.includes(t)),
    banned.join(","),
  );
  const tools = byId(list, "CONTRACT-TOOLS");
  check("白名单内的工具不进禁止名单", !members(tools?.selector?.toolPattern).includes("Read"), tools?.selector?.toolPattern);
  check("契约断言都参与 completion（门禁主项）", list.every((a) => a.scoring.includes("completion")));
  check("契约断言都不允许等价替代", list.every((a) => a.allowEquivalent === false));
}

process.stdout.write("\n── 声明了写权限的岗位 ──\n");
{
  const list = deriveContractAssertions(base({ tools: ["Read", "Write", "Bash"] }));
  check("不派生只读约束", !byId(list, "CONTRACT-READONLY"));
  const tools = byId(list, "CONTRACT-TOOLS");
  const forbidden = members(tools?.selector?.toolPattern);
  check("已声明的 Write 不被判违规", !forbidden.includes("Write"), forbidden.join(","));
  check("未声明的 Edit 仍被判违规", forbidden.includes("Edit"), forbidden.join(","));
}

process.stdout.write("\n── 只读根 ──\n");
{
  const list = deriveContractAssertions(base({ tools: ["Read"], readRoots: ["${knowledgeDir}"] }));
  const scope = byId(list, "CONTRACT-READ-SCOPE");
  check("派生出路径范围约束", scope?.type === "scope");
  check("带路径的工具都受约束", ["Read", "Grep", "Glob"].every((t) => scope?.tools?.includes(t)) === true);
  check("放行清单含 <workspace> 占位", scope?.allow?.includes("<workspace>") === true, JSON.stringify(scope?.allow));
  check(
    "占位符已展开成绝对路径",
    scope?.allow?.some((p) => p.startsWith("/")) === true,
    JSON.stringify(scope?.allow),
  );
}

process.stdout.write("\n── 什么都没声明的岗位 ──\n");
{
  const list = deriveContractAssertions(base({}));
  // 宁可一条不派生，也不要凭猜测造出会误判的断言
  check("不派生任何断言", list.length === 0, `实际 ${list.length} 条`);
}

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
