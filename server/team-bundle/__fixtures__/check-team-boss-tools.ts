/**
 * Boss 对话侧的团队导入导出 E2E（零 LLM，直接驱动工具的 execute）。
 *
 * **必须在独立 RUNTIME_DIR 下运行**：它会真的执行导入。
 *
 * 为什么要这一层：`check-team-api.ts` 覆盖的是后台 HTTP 路径，而 boss 走的是另一条路
 * （工具注册条件 + 用户原话判定 + 自己拿确认令牌）。这条路上的闸门是**独立实现**的，
 * 后台那边测过不代表这边成立。真实风险很具体：
 * - 整体覆盖会删本地资产，而 boss 侧的授权凭据只有「用户这句话」；
 * - 一句「确认」在添加/合并语境下够用，在覆盖语境下不够——两者必须用不同判据；
 * - 工具不该在聊天里索要 Token，否则凭据会留在聊天记录里。
 *
 * 用法：RUNTIME_DIR=$(mktemp -d) npx tsx server/team-bundle/__fixtures__/check-team-boss-tools.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config/index.js";
import { saveHiredProfile, loadAgentProfile, listHiredProfiles } from "../../config/agent-profile.js";
import { buildBossTools } from "../../boss/tools/boss-tools.js";
import { listRoutableAgents } from "../../agents/registry.js";
import { exportTeamBundle } from "../bundle.js";
import { diffLocalBindings, snapshotLocalBindings } from "../local-guard.js";
import type { ChannelMessage } from "../../channels/types.js";
import { requireIsolatedRuntimeDir } from "./isolation-guard.js";

requireIsolatedRuntimeDir("server/team-bundle/__fixtures__/check-team-boss-tools.ts");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

const CHAT = `fixture:boss-team-${process.pid}`;

/** 造一个带 .ait-team 附件的用户消息；text 就是「用户原话」，闸门全靠它判 */
function msgWith(text: string, attachPath?: string): ChannelMessage {
  return {
    channel: "cli",
    chatId: CHAT,
    chatType: "private",
    senderId: "tester",
    senderName: "测试用户",
    text,
    ...(attachPath ? { attachments: [{ name: "team.ait-team", path: attachPath, size: 1 }] } : {}),
  } as ChannelMessage;
}

function toolsFor(msg: ChannelMessage): Record<string, { execute: (args: never) => Promise<string> }> {
  return buildBossTools({
    msg,
    candidates: listRoutableAgents(),
    waiting: [],
    onAction: () => {},
  }) as unknown as Record<string, { execute: (args: never) => Promise<string> }>;
}

/**
 * 直接调 `execute`，绕过模型与 zod 解析。
 *
 * **注意**：绕过 zod 也就绕过了 `.default()`，所以带默认值的入参（如 attachmentIndex、
 * onConflict）必须在调用处显式传，否则拿到 undefined。这是直调的产物，不是产品缺陷——
 * 线上由 AI SDK 解析 inputSchema 时会补上默认值。
 */
async function run(
  msg: ChannelMessage,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = toolsFor(msg)[name];
  if (!tool) throw new Error(`工具 ${name} 未注册`);
  return await tool.execute(args as never);
}

async function main(): Promise<void> {
  saveHiredProfile({
    id: "boss-fixture-emp",
    displayName: "被导员工",
    description: "导入导出 E2E 用",
    routeHint: "【选我当】永不\n【别选我当】永远",
    type: "simple",
    systemPrompt: "被导员工",
    model: "local-only-model",
  });
  saveHiredProfile({
    id: "boss-fixture-local",
    displayName: "本地专属",
    description: "整体覆盖会删掉它",
    routeHint: "【选我当】永不\n【别选我当】永远",
    type: "simple",
    systemPrompt: "本地专属",
  });

  process.stdout.write("\n── 导出：范围明确即可直接执行 ──\n");
  const exportOut = await run(msgWith("把团队导出一份"), "export_team_config", {});
  check("导出直接完成并给出下载地址", exportOut.includes("已导出") && exportOut.includes("下载"));
  check(
    "导出回执明确说清凭据只带占位符",
    exportOut.includes("占位符"),
    exportOut.split("\n")[2] ?? "",
  );
  check(
    "导出回执不索要 Token/Key",
    !/请(提供|输入|发送).*(token|key|密钥|凭据)/i.test(exportOut),
  );

  // 落盘一个真实团队包，供后面的导入用
  const bundleDir = join(config.runtimeDir, "fixture-bundles");
  mkdirSync(bundleDir, { recursive: true });
  const bundlePath = join(bundleDir, "team.ait-team");
  // **刻意只导一个员工**：这样 boss-fixture-local 才是「包外的本地员工」，
  // 整体覆盖的删除语义才测得到。用 kind:"full" 的包含全部员工，replace_team 无物可删。
  writeFileSync(
    bundlePath,
    exportTeamBundle({ kind: "employees", agentIds: ["boss-fixture-emp"] }).bytes,
  );

  process.stdout.write("\n── 工具注册即闸门 ──\n");
  check(
    "没上传附件时压根没有 inspect 工具",
    toolsFor(msgWith("导入团队")).inspect_team_config === undefined,
  );
  check(
    "没检查过时压根没有 apply 工具（结构上无法跳过检查）",
    toolsFor(msgWith("整体覆盖")).apply_team_config === undefined,
  );

  process.stdout.write("\n── 导入必须先检查 ──\n");
  const rosterBeforeInspect = JSON.stringify(listHiredProfiles().map((a) => a.id).sort());
  const inspectOut = await run(msgWith("导入这个团队", bundlePath), "inspect_team_config", { attachmentIndex: 1 });
  check("检查产出预览", inspectOut.includes("已安全检查团队包"));
  check("检查明确声明未改配置", inspectOut.includes("尚未修改任何配置"));
  check(
    "检查阶段确实零改动",
    JSON.stringify(listHiredProfiles().map((a) => a.id).sort()) === rosterBeforeInspect,
  );

  process.stdout.write("\n── 整体覆盖需要用户原话里的覆盖意图 ──\n");
  const vagueOut = await run(msgWith("确认"), "apply_team_config", { mode: "replace_team", onConflict: "keep" });
  check("泛泛一句「确认」不足以授权整体覆盖", vagueOut.includes("已拒绝"), vagueOut.split("\n")[0] ?? "");
  check("拒绝时说清了会删本地资产", vagueOut.includes("删掉"));
  check("拒绝时给出了更安全的替代模式", vagueOut.includes("add_employees") || vagueOut.includes("merge"));
  check(
    "被拒后本地专属员工还在",
    loadAgentProfile("boss-fixture-local") !== undefined,
  );

  process.stdout.write("\n── 提问不算确认 ──\n");
  const questionOut = await run(msgWith("整体覆盖会有什么影响？"), "apply_team_config", { mode: "replace_team", onConflict: "keep" });
  check("带问号的追问被判为非确认", questionOut.includes("不是明确的导入确认"), questionOut.split("\n")[0] ?? "");

  process.stdout.write("\n── 明确说出覆盖意图后才放行 ──\n");
  const localBefore = snapshotLocalBindings();
  const applyOut = await run(msgWith("就按整体覆盖来吧"), "apply_team_config", { mode: "replace_team", onConflict: "keep" });
  check("明确覆盖措辞后应用成功", applyOut.includes("已应用"), applyOut.split("\n")[0] ?? "");
  check("回执给出回滚快照", /回滚快照：\S+/.test(applyOut));
  check("回执声明本地模型与凭据不变", applyOut.includes("保持不变"));
  const violations = diffLocalBindings(localBefore, snapshotLocalBindings());
  check("boss 侧导入后本机绑定零违规", violations.length === 0, violations.join("；"));
  check(
    "整体覆盖确实删掉了包外的本地员工（证明走的是 replace 语义）",
    loadAgentProfile("boss-fixture-local") === undefined,
  );

  process.stdout.write("\n── 应用后 pending 被清掉 ──\n");
  check(
    "同一会话不能用同一次检查再应用一遍",
    toolsFor(msgWith("再整体覆盖一次")).apply_team_config === undefined,
  );

  process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
  if (fail) process.exitCode = 1;
}

void main();
