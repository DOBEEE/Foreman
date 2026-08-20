/**
 * Qoder 外部会话存储（FileSessionStore）回归（零依赖，纯落盘断言）。
 *
 * 存在意义：这个 store 是「Qoder 会话历史不再污染用户 IDE 的 ~/.qoder」的落点。
 * 一旦 append/load 的顺序或 key→路径映射错了，表现是 resume 静默拿错上下文或整轮丢失，
 * 真模型极难复现。这里钉住确定性行为：
 * 1. append 顺序即 load 顺序（entries 必须 append-order，不排序不去重）；
 * 2. 多次 append 累加而非覆盖；
 * 3. 主 transcript 与子代理（subpath）互不串写；listSubkeys 能枚举子 transcript；
 * 4. listSessions 只列主 transcript；
 * 5. 删主 transcript 连带清子代理目录；
 * 6. key 含路径不安全字符（cwd 风格 projectKey、带 `/` 的 subpath）不越界、可回读。
 *
 * 用法：npx tsx server/runtime/__fixtures__/check-qoder-session-store.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "../qoder-session-store.js";
import type { SessionStoreEntry } from "@qoder-ai/qoder-agent-sdk";

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

const e = (type: string, uuid: string): SessionStoreEntry => ({ type, uuid });

const root = mkdtempSync(join(tmpdir(), "qoder-store-"));
const store = new FileSessionStore(root);

// projectKey 用 Qoder 真实风格（cwd 转义名，含非 \w 字符），sessionId 用 uuid 风格
const projectKey = "-Users-me-Documents-code-myproj";
const sessionId = "11111111-1111-4111-8111-111111111111";
const mainKey = { projectKey, sessionId };

try {
  // 1) 空 append 不建文件、load 返回 null
  await store.append(mainKey, []);
  check("空 entries 不落盘、load=null", (await store.load(mainKey)) === null);

  // 2) 分两批 append，load 保持 append order 且累加
  await store.append(mainKey, [e("a", "u1"), e("b", "u2")]);
  await store.append(mainKey, [e("c", "u3")]);
  const loaded = await store.load(mainKey);
  check("load 累加而非覆盖（3 条）", loaded?.length === 3, String(loaded?.length));
  check(
    "顺序即 append order（u1,u2,u3）",
    loaded?.map((x) => x.uuid).join(",") === "u1,u2,u3",
    loaded?.map((x) => x.uuid).join(","),
  );

  // 3) 子代理 transcript 与主 transcript 互不串写
  const subKey = { projectKey, sessionId, subpath: "subagents/agent-7" };
  await store.append(subKey, [e("sub", "s1")]);
  const mainAfter = await store.load(mainKey);
  check("写子代理不污染主 transcript（仍 3 条）", mainAfter?.length === 3, String(mainAfter?.length));
  const subLoaded = await store.load(subKey);
  check("子代理 transcript 可独立回读", subLoaded?.length === 1 && subLoaded[0].uuid === "s1");
  const subkeys = await store.listSubkeys(mainKey);
  check(
    "listSubkeys 枚举出子 transcript",
    subkeys.length === 1 && subkeys[0] === "subagents/agent-7",
    JSON.stringify(subkeys),
  );

  // 4) listSessions 只列主 transcript（不把子代理目录当会话）
  const sessions = await store.listSessions(projectKey);
  check(
    "listSessions 仅主 transcript（1 个）",
    sessions.length === 1 && sessions[0].sessionId === sessionId,
    JSON.stringify(sessions.map((s) => s.sessionId)),
  );

  // 5) key 含路径不安全字符：另起一个带 `/`、`:` 的 projectKey，能写能读、不越界到 root 之外
  const weird = { projectKey: "a/b:c", sessionId: "x/y" };
  await store.append(weird, [e("w", "w1")]);
  const weirdLoaded = await store.load(weird);
  check("路径不安全 key 可回读", weirdLoaded?.length === 1 && weirdLoaded[0].uuid === "w1");

  // 6) 删主 transcript 连带清子代理
  await store.delete(mainKey);
  check("删除后主 transcript load=null", (await store.load(mainKey)) === null);
  check("删除主 transcript 连带清子代理", (await store.load(subKey)) === null);
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  fails.length === 0
    ? `\n━━━ ${pass}/${pass} 通过 ━━━\n`
    : `\n━━━ ${pass}/${pass + fails.length} 通过，失败：${fails.join("、")} ━━━\n`,
);
if (fails.length > 0) process.exitCode = 1;
