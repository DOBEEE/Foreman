/**
 * 员工工作台校验（零 LLM，纯断言）。
 *
 * 锁住的根因：会话（上下文）是**按任务**隔离的，员工在同一个群里干第二件活时是全新会话，
 * 对自己做过什么一无所知。工作台补的就是这个缺口。它必须满足三条，任一条破了就静默失效：
 *
 * 1. **append 而非 read-modify-write**。并发岗位（maxParallel > 1）同一时刻会有两个 run
 *    收尾，"读全文→改→写回"交错时后写的会整体覆盖前一个。`notes` 当初正是因为用了
 *    Read→Write 全文覆盖，才不得不按 taskId 拆文件回避竞争。这里用 O_APPEND，
 *    所以本文件专门起多个**子进程**并发写来验证——同进程内 appendFileSync 是顺序的，
 *    在一个进程里循环写什么也证明不了。
 *
 * 2. **同一 taskId 的记录会重复到达，读时必须后写的赢**。验收返工让任务多次进出 running、
 *    `retryFailed` 复活失败任务、`recoverPendingHandoffs` 重启后主动重放终态钩子——
 *    三条路都会让同一个任务被落库多次。不去重的话索引里会出现同一件活的多个版本。
 *
 * 3. **索引不能随历史无界膨胀**。它要进每个任务的系统提示，全量注入最终会把上下文吃光——
 *    而那正是"共享一条长会话"方案的死法，不能在这里重演。
 *
 * 用法：npx tsx server/core/__fixtures__/check-workbench.ts
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendWorkbench,
  cleanupWorkbench,
  isWorkbenchPath,
  loadWorkbench,
  renderWorkbenchIndex,
  workbenchDirOf,
  workbenchFileOf,
  WORKBENCH_ROOT,
  type WorkbenchRecord,
} from "../workbench.js";

const AGENT = `fx-wb-${process.pid}`;
const CHAT = "cid:群 A/测试";
const OTHER_CHAT = "cid:群 B";
const DAY = Date.parse("2026-08-11T00:00:00Z");

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

function rec(taskId: string, over: Partial<WorkbenchRecord> = {}): WorkbenchRecord {
  return {
    taskId,
    at: DAY,
    state: "done",
    title: `任务 ${taskId}`,
    conclusion: `${taskId} 的结论`,
    ...over,
  };
}

function main(): void {
  rmSync(workbenchDirOf(AGENT), { recursive: true, force: true });

  process.stdout.write("\n── 落库与读回 ──\n");
  appendWorkbench(AGENT, CHAT, rec("t001"));
  appendWorkbench(AGENT, CHAT, rec("t002", { at: DAY + 1000 }));
  const two = loadWorkbench(AGENT, CHAT);
  check("两条都在（append 没互相覆盖）", two.length === 2, String(two.length));
  check("按时间升序", two[0]?.taskId === "t001" && two[1]?.taskId === "t002", two.map((r) => r.taskId).join(","));
  check("空文件/不存在时返回空数组而不是抛错", loadWorkbench(`${AGENT}-none`, CHAT).length === 0);

  process.stdout.write("\n── 隔离：chat 之间、员工之间都不许串 ──\n");
  appendWorkbench(AGENT, OTHER_CHAT, rec("other1"));
  check("另一个 chat 的记录不进本 chat", loadWorkbench(AGENT, CHAT).length === 2);
  check("另一个 chat 自己能读到", loadWorkbench(AGENT, OTHER_CHAT).length === 1);
  appendWorkbench(`${AGENT}-b`, CHAT, rec("mate1"));
  check("另一个员工的记录不进本员工", loadWorkbench(AGENT, CHAT).length === 2);
  check(
    "chatId 里的非法字符被消毒进文件名",
    workbenchFileOf(AGENT, CHAT).endsWith("cid_群 A_测试.jsonl") === false &&
      /[/:]/.test(workbenchFileOf(AGENT, CHAT).split("/").pop() ?? "") === false,
    workbenchFileOf(AGENT, CHAT),
  );

  process.stdout.write("\n── 同一任务重复落库：读时后写的赢 ──\n");
  // 三条路都会重放：验收返工 / retryFailed / 重启补交接
  appendWorkbench(AGENT, CHAT, rec("t001", { at: DAY + 5000, conclusion: "返工后的结论", state: "failed" }));
  const dedup = loadWorkbench(AGENT, CHAT);
  check("总条数没涨（按 taskId 去重）", dedup.length === 2, String(dedup.length));
  const t001 = dedup.find((r) => r.taskId === "t001");
  check("留下的是后写的那条", t001?.conclusion === "返工后的结论", String(t001?.conclusion));
  check("状态也跟着更新", t001?.state === "failed", String(t001?.state));

  process.stdout.write("\n── 真并发写入（多子进程同时 append）──\n");
  const raceAgent = `${AGENT}-race`;
  const N = 12;
  mkdirSync(workbenchDirOf(raceAgent), { recursive: true });
  const raceFile = workbenchFileOf(raceAgent, CHAT);
  // 子进程自己也 mkdir：父进程建过一次，但让子进程不依赖这个前提更稳。
  // 写之前随机等一小会儿，目的是让 12 个进程的写入时刻真正交错——
  // 否则它们大概率一个接一个落地，测不出 O_APPEND 到底原子不原子。
  // 参数走**环境变量**而不是 argv：`node -e` 模式下 process.argv 里**没有**脚本路径那一项
  // （argv = [execPath, ...args]），照常规写 slice(2) 会把第一个参数吃掉——
  // 而子进程照错路径写完还是退出码 0，父进程只会看到"文件不存在"，排查方向全被带偏。
  const script = `
    const { appendFileSync, mkdirSync } = require("node:fs");
    const { dirname } = require("node:path");
    const file = process.env.WB_FILE;
    const id = process.env.WB_ID;
    mkdirSync(dirname(file), { recursive: true });
    const line = JSON.stringify({ taskId: id, at: Date.now(), state: "done", title: "并发 " + id }) + "\\n";
    setTimeout(() => appendFileSync(file, line, "utf-8"), Math.floor(Math.random() * 40));
  `;
  const kids = Array.from({ length: N }, (_, i) =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["-e", script], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, WB_FILE: raceFile, WB_ID: `race${i}` },
      });
      let err = "";
      child.stderr.on("data", (chunk) => {
        err += String(chunk);
      });
      child.on("close", (code) => resolve(code === 0 ? "" : `race${i} exit=${code} ${err.trim()}`));
    }),
  );
  void Promise.all(kids).then((errors) => {
    const bad = errors.filter(Boolean);
    check("所有并发写入子进程都正常退出", bad.length === 0, bad.join(" | "));
    const raced = loadWorkbench(raceAgent, CHAT);
    check(`${N} 个并发写入者一条都没丢`, raced.length === N, `实际 ${raced.length}`);
    check(
      "每行都是完整 JSON（没有交错撕裂）",
      readFileSync(raceFile, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .every((l) => {
          try {
            return typeof (JSON.parse(l) as WorkbenchRecord).taskId === "string";
          } catch {
            return false;
          }
        }),
    );
    rest();
  });
}

function rest(): void {
  process.stdout.write("\n── 索引渲染 ──\n");
  const idx = renderWorkbenchIndex(AGENT, CHAT) ?? "";
  check("含任务号", idx.includes("#t002"), idx);
  check("含结论", idx.includes("t002 的结论"));
  check("失败态有区分标记", idx.includes("❌"), idx);
  check("无记录时返回 undefined（调用方据此决定整段是否出现）", renderWorkbenchIndex(`${AGENT}-empty`, CHAT) === undefined);

  const fieldAgent = `${AGENT}-fields`;
  appendWorkbench(fieldAgent, CHAT, rec("f1", {
    decisions: "选了方案 A，因为 B 在本环境跑不通",
    deliverables: "src/x.ts",
    risks: "无",
  }));
  const fieldIdx = renderWorkbenchIndex(fieldAgent, CHAT) ?? "";
  check("关键决策进索引（这是历史里最值钱的一列）", fieldIdx.includes("选了方案 A"), fieldIdx);
  check("产出物进索引", fieldIdx.includes("src/x.ts"));
  check("risks 填「无」时不渲染，不给模型添噪音", !fieldIdx.includes("遗留："), fieldIdx);

  const multiline = `${AGENT}-flat`;
  appendWorkbench(multiline, CHAT, rec("m1", { conclusion: "第一行\n第二行\n\n第三行" }));
  const flatIdx = renderWorkbenchIndex(multiline, CHAT) ?? "";
  check(
    "多行结论被压成一行（否则索引结构会被员工的换行冲散）",
    !flatIdx.includes("第一行\n第二行"),
    JSON.stringify(flatIdx),
  );

  process.stdout.write("\n── 索引不许随历史无界膨胀 ──\n");
  const bigAgent = `${AGENT}-big`;
  for (let i = 0; i < 30; i++) {
    appendWorkbench(bigAgent, CHAT, rec(`b${i}`, { at: DAY + i }));
  }
  const capped = renderWorkbenchIndex(bigAgent, CHAT, 5) ?? "";
  const shown = capped.split("\n").filter((l) => l.startsWith("- #"));
  check("只渲染 limit 条", shown.length === 5, String(shown.length));
  check("留的是最近的（越近越可能相关）", capped.includes("#b29") && !capped.includes("#b0 "), capped);
  check("明确告知省略了多少，并给出索取途径", capped.includes("已省略") && capped.includes("任务号"), capped);

  process.stdout.write("\n── 坏行不能让整个索引消失 ──\n");
  const badAgent = `${AGENT}-bad`;
  mkdirSync(workbenchDirOf(badAgent), { recursive: true });
  const badFile = workbenchFileOf(badAgent, CHAT);
  writeFileSync(badFile, `{ 这不是 json\n${JSON.stringify(rec("ok1"))}\n\n`, "utf-8");
  const salvaged = loadWorkbench(badAgent, CHAT);
  check("坏行跳过、好行照读", salvaged.length === 1 && salvaged[0]?.taskId === "ok1", JSON.stringify(salvaged));
  appendFileSync(badFile, `${JSON.stringify({ at: 1, state: "done" })}\n`, "utf-8");
  check("缺 taskId 的行也跳过", loadWorkbench(badAgent, CHAT).length === 1);

  process.stdout.write("\n── 过期清理：按行清，不整文件删 ──\n");
  const ttlAgent = `${AGENT}-ttl`;
  const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
  appendWorkbench(ttlAgent, CHAT, rec("veryold", { at: old }));
  appendWorkbench(ttlAgent, CHAT, rec("fresh", { at: Date.now() }));
  appendFileSync(workbenchFileOf(ttlAgent, CHAT), `${JSON.stringify({ taskId: "nostamp", state: "done", title: "无时间戳" })}\n`, "utf-8");
  const removed = cleanupWorkbench(60);
  check("过期行被清掉", removed >= 1, String(removed));
  const kept = loadWorkbench(ttlAgent, CHAT);
  check("新行还在（没被整文件删掉）", kept.some((r) => r.taskId === "fresh"), JSON.stringify(kept.map((r) => r.taskId)));
  check("过期行确实不在了", !kept.some((r) => r.taskId === "veryold"));
  check(
    "缺时间戳的行保留（宁可留着占几字节，不静默删可能有用的记录）",
    kept.some((r) => r.taskId === "nostamp"),
    JSON.stringify(kept.map((r) => r.taskId)),
  );
  check("清理后没留下临时文件（写临时文件 + rename 的收尾）", !hasTmpLeftover(ttlAgent));

  process.stdout.write("\n── 路径判定要带边界 ──\n");
  check("自己目录内为真", isWorkbenchPath(workbenchFileOf(AGENT, CHAT)));
  check("根目录本身为真", isWorkbenchPath(WORKBENCH_ROOT));
  check(
    "同前缀的兄弟目录不许误判（workbench 与 workbench-x）",
    !isWorkbenchPath(`${WORKBENCH_ROOT}-x/a.jsonl`),
  );
  check("目录外为假", !isWorkbenchPath(join(WORKBENCH_ROOT, "..", "notes", "a.md")));

  finish();
}

function hasTmpLeftover(agent: string): boolean {
  try {
    return readdirSync(workbenchDirOf(agent)).some((n) => n.endsWith(".tmp"));
  } catch {
    return false;
  }
}

function finish(): void {
  // 只清自己造的那几个目录，绝不按前缀批量删 —— 并行跑别的 fixture 时会互相拆台
  for (const suffix of ["", "-b", "-race", "-empty", "-fields", "-flat", "-big", "-bad", "-ttl"]) {
    rmSync(workbenchDirOf(`${AGENT}${suffix}`), { recursive: true, force: true });
  }
  process.stdout.write(`\n通过 ${pass}，失败 ${fails.length}\n`);
  if (fails.length > 0) {
    process.stdout.write(`失败项：${fails.join("；")}\n`);
    process.exit(1);
  }
}

main();
