/**
 * hr 提权路径回归（零 LLM，纯断言）。
 *
 * 背景：hr 原先持有 `Write` 且工作目录就是 hiredAgentsDir，于是它能写 `coder.json`——
 * 而与内置岗位同名的文件会被 loadAgentProfile 当作**非严格校验的权限覆盖层**浅合并，
 * 等于可以给任意内置员工开 Bash / 任意 MCP。这里钉住修复后的三条不变量。
 *
 * 用法：npx tsx server/boss/__fixtures__/check-hr-guard.ts
 */

import { existsSync, unlinkSync } from "node:fs";
import { config } from "../../config/index.js";
import { hiredProfilePath, loadAgentProfile } from "../../config/agent-profile.js";
import { getAgent, getBuiltinAgentIds } from "../../agents/registry.js";
import { buildSaveEmployeeTool } from "../../agents/builtin/hr-tools.js";

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

type Exec = (args: Record<string, unknown>) => Promise<string>;

async function main(): Promise<void> {
  const hr = getAgent("hr");
  const profile = hr?.profile;

  process.stdout.write("\n── hr 的声明式权限 ──\n");
  check("hr 存在", Boolean(profile));
  check("tools 白名单不含 Write", !(profile?.tools ?? []).includes("Write"), JSON.stringify(profile?.tools));
  check(
    "工作目录已挪出 hiredAgentsDir（否则写权限直达内置岗位覆盖层）",
    !(profile?.workspace ?? "").includes("hiredAgentsDir"),
    profile?.workspace,
  );
  check(
    "声明了 readRoots（门禁只在声明后才启用，写入被限到自己的工作目录）",
    (profile?.readRoots ?? []).length > 0,
    JSON.stringify(profile?.readRoots),
  );

  process.stdout.write("\n── save_employee 的护栏 ──\n");
  const exec = (buildSaveEmployeeTool() as unknown as { execute: Exec }).execute;
  const base = {
    id: "probe-emp",
    displayName: "探针",
    description: "回归测试用",
    routeHint: "【选我当】测试时；【别选我当】其他任何时候",
    systemPrompt: "你是回归测试探针。",
  };

  const builtin = getBuiltinAgentIds()[0];
  const hijack = await exec({ profile: { ...base, id: builtin }, overwrite: true });
  check(`拒绝写内置岗位名（${builtin}）`, hijack.includes("拒绝写入"), hijack.slice(0, 80));

  const bad = await exec({ profile: { ...base, systemPrompt: "" } });
  check("空 systemPrompt 被校验拦下", bad.includes("校验"), bad.slice(0, 80));

  const badSop = await exec({
    profile: { ...base, type: "sop", steps: [{ id: "s1", title: "t", prompt: "p", mode: "delegate" }] },
  });
  check("delegate 步没指定受派人被拦下", badSop.includes("校验"), badSop.slice(0, 80));

  const ok1 = await exec({ profile: base });
  check("合法配置能落盘", ok1.includes("已写入"), ok1.slice(0, 80));
  const dup = await exec({ profile: base });
  check("重名未声明 overwrite 时拒绝", dup.includes("已经存在"), dup.slice(0, 80));
  const ok2 = await exec({ profile: { ...base, description: "改过了" }, overwrite: true });
  check("显式 overwrite 才允许覆盖", ok2.includes("已写入"), ok2.slice(0, 80));

  process.stdout.write("\n── 内置岗位未被污染 ──\n");
  const coder = loadAgentProfile(builtin);
  check(`${builtin} 仍是 builtin 来源`, coder?.source === "builtin");
  check(`${builtin} 未被写出覆盖层文件`, !existsSync(hiredProfilePath(builtin)));

  // 收尾
  const probe = hiredProfilePath("probe-emp");
  if (existsSync(probe)) unlinkSync(probe);
  check("探针已清理", !existsSync(probe));

  process.stdout.write(`\n运行时目录：${config.runtimeDir}\n`);
  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

void main();
