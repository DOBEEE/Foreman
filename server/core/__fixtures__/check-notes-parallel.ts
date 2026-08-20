/**
 * 并发岗位的笔记分文件校验（零 LLM，纯断言）。
 *
 * 锁住的根因：笔记是「一个员工一天一个文件」，而员工写笔记的方式是
 * 「Read 现有全文 → Write 追加后的全文」。串行时没问题；并发岗位同一天两个 run 交错时，
 * 后写的那个会**整体覆盖**前一个，静默丢掉一整份笔记 —— 而笔记是复盘信号密度最高的输入
 * （复盘提示词里明确「最高信号密度，先读」），丢了就是复盘失真且无人察觉。
 *
 * 第二个易漏点：拆了文件却没改 `noteFilesForRetro`。它原先是「拼精确文件名」，
 * 只会命中 `<date>.md`，那些 `<date>.<taskId>.md` 会被复盘整体看不见 ——
 * 表现和「员工压根没记笔记」一模一样。
 *
 * 用法：npx tsx server/core/__fixtures__/check-notes-parallel.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  cleanupNotes,
  noteFileOf,
  noteFilesForRetro,
  notesDirOf,
  readTodayNote,
} from "../notes.js";

const AGENT = `fx-notes-${process.pid}`;
// 刻意用**过去**的固定日期：cleanupNotes 按「文件名日期当天 23:59:59」算保留期，
// 用今天的日期那个时刻还在未来，ttl=0 也删不掉，会把清理断言误判成失败。
const DAY = "2020-01-02";
const YESTERDAY = "2020-01-01";

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

function write(file: string, text: string): void {
  mkdirSync(notesDirOf(AGENT), { recursive: true });
  writeFileSync(file, text, "utf-8");
}

function main(): void {
  const dir = notesDirOf(AGENT);
  rmSync(dir, { recursive: true, force: true });

  process.stdout.write("\n── 回归锚：串行岗位路径一字不变 ──\n");
  const serial = noteFileOf(AGENT, DAY);
  check("不给 taskId 时仍是 <date>.md", serial.endsWith(`/${DAY}.md`), serial);

  process.stdout.write("\n── 并发岗位按任务分文件 ──\n");
  const fileA = noteFileOf(AGENT, DAY, "aaa111");
  const fileB = noteFileOf(AGENT, DAY, "bbb222");
  check("同一天两个任务落到两个文件", fileA !== fileB, `${fileA} vs ${fileB}`);
  check("文件名保留日期前缀（复盘按它扫、清理按它算保留期）", fileA.includes(`/${DAY}.`), fileA);
  check("同一任务两次解析同一文件", noteFileOf(AGENT, DAY, "aaa111") === fileA);

  // 复现踩踏：两个 run 各写自己那份，互不覆盖
  write(fileA, "## aaa111\n- 坑：A 的教训\n");
  write(fileB, "## bbb222\n- 坑：B 的教训\n");
  check("A 的笔记还在", readFileSync(fileA, "utf-8").includes("A 的教训"));
  check("B 的笔记也还在（没被 A 覆盖）", readFileSync(fileB, "utf-8").includes("B 的教训"));
  check("readTodayNote 能按 taskId 取到本任务那份", readTodayNote(AGENT, DAY, "bbb222")?.includes("B 的教训") === true);

  process.stdout.write("\n── 复盘必须同时读到所有并行任务的笔记 ──\n");
  const forRetro = noteFilesForRetro(AGENT, DAY, 1);
  check("当天两份都被列入复盘输入", forRetro.length === 2, forRetro.join(","));
  check("顺序稳定（按文件名排序，不随文件系统漂）", forRetro[0] === fileA && forRetro[1] === fileB, forRetro.join(","));

  // 串行那份也在同一天：三份都要被读到
  write(serial, "## 串行\n- 坑：串行那份\n");
  const mixed = noteFilesForRetro(AGENT, DAY, 1);
  check("<date>.md 与 <date>.<taskId>.md 混存时全都读到", mixed.length === 3, mixed.join(","));

  write(noteFileOf(AGENT, YESTERDAY, "ccc333"), "## ccc333\n- 昨天的\n");
  const twoDays = noteFilesForRetro(AGENT, DAY, 2);
  check("lookback 覆盖到昨天的并行笔记", twoDays.length === 4, twoDays.join(","));
  check(
    "天与天之间仍是由近到远",
    twoDays.slice(0, 3).every((f) => f.includes(DAY)) && twoDays[3].includes(YESTERDAY),
    twoDays.join(","),
  );

  process.stdout.write("\n── 清理按文件名日期算，不退化到 mtime ──\n");
  // 这些文件的 mtime 是「刚刚」，而文件名日期是 2026-08-10。
  // ttl 给 0 天 → 只要按文件名判就该全删；若退化到 mtime 则一个都删不掉。
  const before = noteFilesForRetro(AGENT, DAY, 2).length;
  check("清理前有 4 份", before === 4, String(before));
  cleanupNotes(0);
  check("带任务号中缀的过期笔记被删（正则认得它）", !existsSync(fileA) && !existsSync(fileB), fileA);
  check("普通 <date>.md 也被删", !existsSync(serial));

  process.stdout.write(`\n━━━ ${pass}/${pass + fails.length} 通过 ━━━\n`);
  if (fails.length) {
    process.stdout.write(`未通过：${fails.join("、")}\n`);
    process.exitCode = 1;
  }
}

try {
  main();
} finally {
  // 只删自己造的那个员工目录
  rmSync(notesDirOf(AGENT), { recursive: true, force: true });
}
