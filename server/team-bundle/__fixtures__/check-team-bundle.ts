/**
 * 团队包协议、安全和事务回归。
 *
 * **必须在独立 RUNTIME_DIR 下运行**，这条现在由 requireIsolatedRuntimeDir 真的执行 ——
 * 它做的是真实的团队导入，跑在默认目录上会把用户的 boss 人格、员工、MCP、Skill
 * 换成团队包里的测试数据，而且导入是「成功」的、不报任何错。
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { config } from "../../config/index.js";
import { loadAgentProfile, listHiredProfiles, saveHiredProfile } from "../../config/agent-profile.js";
import { getBuiltinAgentIds } from "../../agents/registry.js";
import { taskManager as tm } from "../../boss/task-manager.js";
import {
  diffLocalBindings,
  snapshotLocalBindings,
  LOCAL_AGENT_FIELDS,
} from "../local-guard.js";
import { saveMcpServer } from "../../config/mcp-store.js";
import { writeBossOverlay } from "../../config/settings-store.js";
import { saveSkill } from "../../core/skill-store.js";
import { listMcpServers } from "../../core/mcp.js";
import { exportTeamBundle, parseTeamBundle } from "../bundle.js";
import { applyTeamImport, inspectTeamBundle, restoreTeamSnapshot } from "../importer.js";
import { requireIsolatedRuntimeDir } from "./isolation-guard.js";

// 第一个写操作之前就拦住
requireIsolatedRuntimeDir("server/team-bundle/__fixtures__/check-team-bundle.ts");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

const SECRET = "sk-fixture-super-secret-123456789";
const LOCAL_PATH = `${config.runtimeDir}/private-workspace`;

saveHiredProfile({
  id: "portable-coder",
  displayName: "小码",
  description: "实现代码",
  routeHint: "【选我当】需要编码实现时\n【别选我当】只做资料检索时",
  type: "simple",
  systemPrompt: `在 ${LOCAL_PATH} 工作，旧测试 key=${SECRET}`,
  model: "local-private-model",
  provider: { id: "private-provider", model: "another-private-model", baseUrl: "https://private.invalid" },
  workspace: LOCAL_PATH,
  readRoots: [LOCAL_PATH],
  tools: ["Read", "Write", "mcp__private-mcp"],
  mcpServers: ["private-mcp"],
  skills: ["user:portable-skill"],
});
saveSkill({
  name: "portable-skill",
  description: "测试团队包",
  body: `只读取 ${LOCAL_PATH}，Authorization: Bearer ${SECRET}`,
});
saveMcpServer({
  name: "private-mcp",
  scope: "optional",
  decl: {
    type: "http",
    url: `https://example.invalid/mcp?tenant=abc&token=${SECRET}`,
    headers: { Authorization: `Bearer ${SECRET}` },
  },
});
writeBossOverlay({
  name: "测试主管",
  role: "主管",
  personality: "直接",
  style: "简练",
  team: `团队目录 ${LOCAL_PATH}`,
  employees: { "portable-coder": "小码" },
});

process.stdout.write("\n── 白名单导出与脱敏 ──\n");
const generated = exportTeamBundle({ kind: "full" });
const json = gunzipSync(generated.bytes).toString("utf-8");
const portable = generated.envelope.payload.agents.find((a) => a.id === "portable-coder")!;
check("团队包不含模型名", !json.includes("local-private-model") && !("model" in portable));
check("团队包不含 provider", !json.includes("private-provider") && !("provider" in portable));
check("团队包不含真实 secret", !json.includes(SECRET));
check("本机路径被替换", !json.includes(LOCAL_PATH) && json.includes("${runtimeDir}"));
check("workspace/readRoots 不进入员工对象", !("workspace" in portable) && !("readRoots" in portable));
const exportedMcp = generated.envelope.payload.mcps.find((m) => m.name === "private-mcp")!;
check("MCP header/query 变成本机绑定", exportedMcp.requiredBindings.length >= 2);
check("URL 占位符没有被 percent-encode", exportedMcp.decl.url?.includes("${AIT_MCP_") === true);

process.stdout.write("\n── 格式与完整性 ──\n");
const parsed = parseTeamBundle(generated.bytes);
check("gzip 团队包可往返解析", parsed.integrity.digest === generated.envelope.integrity.digest);
const tampered = JSON.parse(json) as typeof generated.envelope;
tampered.payload.meta.name = "被篡改";
let tamperRejected = false;
try {
  parseTeamBundle(gzipSync(JSON.stringify(tampered)));
} catch {
  tamperRejected = true;
}
check("内容篡改被哈希校验拒绝", tamperRejected);

process.stdout.write("\n── 检查、替换与本机绑定保留 ──\n");
const inspection = inspectTeamBundle(parsed);
check("同名员工/Skill/MCP 被识别为冲突", inspection.conflicts.agents.includes("portable-coder") && inspection.conflicts.skills.includes("portable-skill") && inspection.conflicts.mcps.includes("private-mcp"));
const plan = inspection.defaultPlans.replace_team;
const result = applyTeamImport(parsed, plan);
const after = loadAgentProfile("portable-coder")!;
check("替换团队仍保留本地员工模型", after.model === "local-private-model" && after.provider?.id === "private-provider");
check("替换团队仍保留本地路径绑定", after.workspace === LOCAL_PATH && after.readRoots?.[0] === LOCAL_PATH);
const afterMcp = listMcpServers().find((m) => m.name === "private-mcp")!;
check("替换 MCP 复用本地 header secret", JSON.stringify(afterMcp.decl).includes(SECRET));
check("应用返回可回滚快照", Boolean(result.snapshotId));

after.systemPrompt = "回滚前的人为修改";
saveHiredProfile(after);
restoreTeamSnapshot(result.snapshotId);
const restored = loadAgentProfile("portable-coder")!;
check("快照回滚恢复导入前员工配置", restored.systemPrompt?.includes(LOCAL_PATH) === true);

process.stdout.write("\n── 阶段4：公开常量与凭据分级 ──\n");
const PLAIN_SECRET = "sk-graded-abcdefghijklmnopqrst";
const OPAQUE_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const URL_SIG = "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c";
saveMcpServer({
  name: "graded-mcp",
  scope: "optional",
  decl: {
    type: "http",
    url: `https://api.example.invalid/v1?region=cn-hangzhou&sig=${URL_SIG}`,
    headers: {
      // 键名判据：值短得根本判不出来，只有键名能说明它是凭据
      Authorization: "short",
      // 公开常量：应原样带走，否则导入方要为它手填一遍才能启用这个 MCP
      "X-Env": "production",
      // ${VAR} 契约：本仓库既有的凭据表达方式（core/mcp.ts expandEnv）
      "X-Key": "${GRADED_PROBE_SECRET}",
      // 密钥被写成字面量的两种常见形态
      "X-Legacy": PLAIN_SECRET,
      "X-Opaque": OPAQUE_SECRET,
    },
  },
});
const graded = exportTeamBundle({ kind: "full" });
const gradedJson = gunzipSync(graded.bytes).toString("utf-8");
const gradedMcp = graded.envelope.payload.mcps.find((m) => m.name === "graded-mcp")!;
const gradedHeaders = gradedMcp.decl.headers ?? {};
const boundKeys = new Set(gradedMcp.requiredBindings.map((b) => b.key));

check("公开常量原样带出（header）", gradedHeaders["X-Env"] === "production");
check("公开常量原样带出（url query）", gradedMcp.decl.url?.includes("region=cn-hangzhou") === true);
check("${VAR} 契约保留原变量名，不重命名", gradedHeaders["X-Key"] === "${GRADED_PROBE_SECRET}");
check("键名判据：Authorization 即使值很短也转绑定", boundKeys.has("Authorization") && gradedHeaders["Authorization"] !== "short");
check("前缀模式判据：sk- 字面量转绑定", boundKeys.has("X-Legacy"));
check("高熵判据：裸随机串转绑定", boundKeys.has("X-Opaque"));
check("高熵判据也覆盖 url query 参数", boundKeys.has("sig"));
for (const [label, value] of [
  ["sk- 字面量", PLAIN_SECRET],
  ["裸随机串", OPAQUE_SECRET],
  ["url 签名", URL_SIG],
] as const) {
  check(`包内搜不到${label}原文`, !gradedJson.includes(value));
}
const gradedWarnings = graded.summary.warnings.join("\n");
check(
  "字面量凭据产出可执行告警（提示改用 ${VAR}）",
  gradedWarnings.includes("X-Legacy") && gradedWarnings.includes("${VAR}"),
  gradedWarnings,
);

process.stdout.write("\n── carriedLiterals 安全网 ──\n");
const literals = graded.summary.carriedLiterals;
const literalKeys = literals.filter((l) => l.mcp === "graded-mcp").map((l) => `${l.target}.${l.key}`).sort();
check(
  "恰好列出全部原样带出的值（不多不少）",
  literalKeys.join(",") === "header.X-Env,url.region",
  literalKeys.join(","),
);
check(
  "被判为凭据的字段一个都不在清单里",
  !literals.some((l) => ["Authorization", "X-Key", "X-Legacy", "X-Opaque", "sig"].includes(l.key)),
);
check(
  "清单里的值与包内实际带出的值一致（不是另算的一份）",
  literals.every((l) => gradedJson.includes(l.value)),
);
// 这条锁住「安全网必须覆盖到每一个 MCP」：老的 private-mcp 里 tenant=abc 也是公开常量
check(
  "安全网覆盖所有被导出的 MCP，不只最后一个",
  literals.some((l) => l.mcp === "private-mcp" && l.key === "tenant"),
  literals.map((l) => `${l.mcp}.${l.key}`).join(","),
);

process.stdout.write("\n── 协议层：本机字段绝不出现在可分享类型里 ──\n");
// 静态断言：任何本机字段若被加进 PortableAgent，就是协议漏洞（导入会把它带过来）。
// 用一份「所有导出员工对象的键」并集来查，比逐个字段写死更抗将来加字段。
const portableKeys = new Set(graded.envelope.payload.agents.flatMap((a) => Object.keys(a)));
const leaked = LOCAL_AGENT_FIELDS.filter((f) => portableKeys.has(f));
check("LOCAL_AGENT_FIELDS 与导出员工字段零重叠", leaked.length === 0, leaked.join(","));

process.stdout.write("\n── 添加员工不影响现有员工 ──\n");
saveHiredProfile({
  id: "bystander",
  displayName: "旁观者",
  description: "不该被这次导入碰到",
  routeHint: "【选我当】永不\n【别选我当】永远",
  type: "simple",
  systemPrompt: "旁观者",
  model: "bystander-model",
  workspace: `${config.runtimeDir}/bystander-ws`,
});
const bystanderBefore = JSON.stringify(loadAgentProfile("bystander"));
const addPlan = inspectTeamBundle(parseTeamBundle(graded.bytes)).defaultPlans.add_employees;
applyTeamImport(parseTeamBundle(graded.bytes), addPlan);
check(
  "add_employees 后未涉及的员工逐字段不变",
  JSON.stringify(loadAgentProfile("bystander")) === bystanderBefore,
);

process.stdout.write("\n── rename 后三处引用都被重写 ──\n");
saveHiredProfile({
  id: "ref-target",
  displayName: "被引用者",
  description: "被 SOP 与 reviewer 指向",
  routeHint: "【选我当】永不\n【别选我当】永远",
  type: "simple",
  systemPrompt: "被引用者",
});
saveHiredProfile({
  id: "ref-holder",
  displayName: "引用者",
  description: "SOP 里委派给 ref-target，且默认审查者也是它",
  routeHint: "【选我当】永不\n【别选我当】永远",
  type: "sop",
  systemPrompt: "引用者",
  reviewer: "ref-target",
  steps: [{ id: "s1", title: "干活", prompt: "干活", delegate: "ref-target", reviewer: "ref-target" }],
});
const refBundle = parseTeamBundle(exportTeamBundle({ kind: "employees", agentIds: ["ref-holder"] }).bytes);
const refPlan = inspectTeamBundle(refBundle).defaultPlans.merge;
refPlan.agentConflicts["ref-target"] = { action: "rename", targetId: "ref-renamed" };
// ref-holder 必须显式 replace 才会被重新落盘。merge 默认是 keep（跳过同名员工）——
// 那种情况下本地 ref-holder 保持指向本地 ref-target 是**正确行为**（那个员工还在），
// 所以要测「引用被重写」就得让持有引用的这一方真的被写一遍。
refPlan.agentConflicts["ref-holder"] = { action: "replace" };
applyTeamImport(refBundle, refPlan);
const holder = loadAgentProfile("ref-holder")!;
check("员工级 reviewer 指向新 id", holder.reviewer === "ref-renamed", String(holder.reviewer));
check("SOP delegate 指向新 id", holder.steps?.[0]?.delegate === "ref-renamed", String(holder.steps?.[0]?.delegate));
check("SOP reviewer 指向新 id", holder.steps?.[0]?.reviewer === "ref-renamed", String(holder.steps?.[0]?.reviewer));

process.stdout.write("\n── 活跃任务阻止整体覆盖，且不留半套配置 ──\n");
const CHAT = `fixture:team-${process.pid}`;
tm.setTerminalHook(() => {});
tm.create({
  channel: "cli",
  chatId: CHAT,
  chatType: "private",
  ownerSenderId: "tester",
  ownerSenderName: "测试",
  agentName: "portable-coder",
  prompt: "正在干活",
});
const beforeBusy = snapshotLocalBindings();
const busyAgents = JSON.stringify(listHiredProfiles().map((a) => a.id).sort());
let busyBlocked = false;
try {
  applyTeamImport(parseTeamBundle(graded.bytes), inspectTeamBundle(parseTeamBundle(graded.bytes)).defaultPlans.replace_team);
} catch (error) {
  busyBlocked = /活跃任务/.test(error instanceof Error ? error.message : String(error));
}
check("有活跃任务时整体覆盖被拒", busyBlocked);
check("被拒后员工名册零改动", JSON.stringify(listHiredProfiles().map((a) => a.id).sort()) === busyAgents);
check("被拒后本机绑定零改动", diffLocalBindings(beforeBusy, snapshotLocalBindings()).length === 0);
for (const t of tm.allTasks().filter((t) => t.chatId === CHAT)) tm.cancel(CHAT, t.id);

process.stdout.write("\n── 注入故障 → 自动回滚 ──\n");
const beforeFail = snapshotLocalBindings();
const rosterBeforeFail = JSON.stringify(
  listHiredProfiles().map((a) => `${a.id}:${a.systemPrompt}`).sort(),
);
const failBundle = parseTeamBundle(graded.bytes);
const failPlan = inspectTeamBundle(failBundle).defaultPlans.merge;
// rename 到一个内置岗位 id：applyTeamImport 会在写入循环中途抛错（内置岗位不可覆盖），
// 也就是「已经写了一部分」的那种失败——正是要验证回滚的场景
failPlan.agentConflicts["portable-coder"] = { action: "rename", targetId: getBuiltinAgentIds()[0] };
let failThrew = false;
try {
  applyTeamImport(failBundle, failPlan);
} catch {
  failThrew = true;
}
check("非法计划导致导入失败", failThrew);
check(
  "失败后员工配置逐条还原（不留半套）",
  JSON.stringify(listHiredProfiles().map((a) => `${a.id}:${a.systemPrompt}`).sort()) === rosterBeforeFail,
);
check("失败后本机绑定指纹一致", diffLocalBindings(beforeFail, snapshotLocalBindings()).length === 0);

process.stdout.write("\n── 正常导入前后本机绑定不变 ──\n");
const beforeOk = snapshotLocalBindings();
applyTeamImport(parseTeamBundle(graded.bytes), inspectTeamBundle(parseTeamBundle(graded.bytes)).defaultPlans.merge);
const okViolations = diffLocalBindings(beforeOk, snapshotLocalBindings());
check("一次正常合并导入后本机绑定零违规", okViolations.length === 0, okViolations.join("；"));

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail) process.exitCode = 1;
