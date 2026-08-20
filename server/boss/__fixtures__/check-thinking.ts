/**
 * 脑爆能力的结构性校验（零 LLM，纯断言）。
 *
 * 为什么这几条值得单独测：
 * 1. **更新槽位 vs 追加**：这是脑爆摘要跟「聊天记录副本」的根本区别。
 *    一旦退化成追加，回读就变成付费读一份劣质对话拷贝——比不记还糟。
 * 2. **话题名归一化**：boss 每轮可能换个说法（「缓存方案」/「缓存、方案」）。
 *    不归一化就会开出一堆孤立记录，摘要永远攒不起来。
 * 3. **索引上限**：索引是唯一常驻进 boss 上下文的部分，不设上限它自己就是
 *    下一个膨胀源（半年后聊过 200 个话题）。
 * 4. **否掉的路必须留住理由**：这是最值钱也最容易被会话压缩吃掉的内容。
 * 5. **模式 TTL**：刻意没有「脑爆结束」检测，靠静默过期降回索引。
 *
 * 用法：npx tsx server/boss/__fixtures__/check-thinking.ts
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config/index.js";
import {
  captureTopic,
  readTopic,
  listTopicIndex,
  topicKey,
  renderTopicIndex,
  renderTopicDigest,
  thinkingModeSection,
  looksLikeThinkingRequest,
  enterThinkingMode,
  exitThinkingMode,
  activeThinkingTopic,
  _resetModesForTest,
  TOPIC_INDEX_LIMIT,
} from "../thinking-store.js";

const CHAT = "fixture_thinking_chat";
let pass = 0;
const fails: string[] = [];

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    process.stdout.write(`  \u2705 ${label}\n`);
  } else {
    fails.push(label);
    process.stdout.write(`  \u274C ${label}${detail ? ` — ${detail}` : ""}\n`);
  }
}

/** 只清本 fixture 自己造的话题文件，绝不整目录删（并行跑别的 fixture 会互相打死） */
function cleanup(): void {
  const dir = join(config.runtimeDir, "thinking");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const file = join(dir, f);
    try {
      const d = JSON.parse(readFileSync(file, "utf-8")) as { chatId?: string };
      if (d.chatId === CHAT) rmSync(file);
    } catch {
      /* 读不动就跳过，不是本 fixture 该管的 */
    }
  }
}

function main(): void {
  cleanup();
  _resetModesForTest();

  // ─── 槽位更新而非追加 ──
  process.stdout.write("\n── 更新槽位 vs 追加（脑爆摘要的根本纪律）──\n");
  captureTopic(CHAT, "缓存方案", { options: ["Redis", "本地内存"] });
  captureTopic(CHAT, "缓存方案", { options: ["CDN 边缘缓存"] });
  const d1 = readTopic(CHAT, "缓存方案");
  check("多次 capture 合并进同一话题", d1?.options.length === 3, JSON.stringify(d1?.options));

  captureTopic(CHAT, "缓存方案", { options: ["Redis"] });
  const d2 = readTopic(CHAT, "缓存方案");
  check("重复内容自动去重（不堆成一长串）", d2?.options.length === 3, JSON.stringify(d2?.options));

  // ─── 话题名归一化 ──
  process.stdout.write("\n── 话题名归一化（boss 换说法不该开新记录）──\n");
  check("空格差异收敛到同一 key", topicKey(CHAT, "缓存方案") === topicKey(CHAT, " 缓存方案 "));
  check("标点差异收敛到同一 key", topicKey(CHAT, "缓存方案") === topicKey(CHAT, "缓存、方案"));
  check("不同话题 key 不同", topicKey(CHAT, "缓存方案") !== topicKey(CHAT, "鉴权方案"));
  check("不同 chat 隔离", topicKey("chatA", "缓存方案") !== topicKey("chatB", "缓存方案"));

  captureTopic(CHAT, "缓存、方案", { conclusions: ["先上 Redis"] });
  const d3 = readTopic(CHAT, "缓存方案");
  check("换标点写法仍落进原话题", d3?.conclusions.length === 1, JSON.stringify(d3?.conclusions));

  // ─── 否掉的路 + 理由 ──
  process.stdout.write("\n── 否掉的路必须留住理由（最易被会话压缩吃掉）──\n");
  captureTopic(CHAT, "缓存方案", {
    rejected: [{ option: "本地内存", reason: "多实例下不一致" }],
  });
  const d4 = readTopic(CHAT, "缓存方案");
  check("否决项落盘", d4?.rejected.length === 1);
  check("理由被保留", d4?.rejected[0]?.reason === "多实例下不一致", d4?.rejected[0]?.reason);

  captureTopic(CHAT, "缓存方案", {
    rejected: [{ option: "本地内存", reason: "多实例不一致，且重启丢数据" }],
  });
  const d5 = readTopic(CHAT, "缓存方案");
  check("同方案再否只留一条（理由取最新）", d5?.rejected.length === 1);
  check("理由已更新为最新", Boolean(d5?.rejected[0]?.reason.includes("重启丢数据")), d5?.rejected[0]?.reason);

  // ─── 空输入保护 ──
  process.stdout.write("\n── 空输入不产生垃圾记录 ──\n");
  const before = readTopic(CHAT, "缓存方案");
  captureTopic(CHAT, "缓存方案", {});
  const after = readTopic(CHAT, "缓存方案");
  check(
    "全空 capture 不改变任何槽位",
    before?.options.length === after?.options.length &&
      before?.conclusions.length === after?.conclusions.length,
  );

  // ─── 索引 ──
  process.stdout.write("\n── 索引（唯一常驻部分，必须有上限）──\n");
  for (let i = 0; i < TOPIC_INDEX_LIMIT + 4; i++) {
    captureTopic(CHAT, `压测话题${i}`, { openQuestions: [`q${i}`] });
  }
  const idx = listTopicIndex(CHAT);
  check(`索引不超过上限 ${TOPIC_INDEX_LIMIT}`, idx.length <= TOPIC_INDEX_LIMIT, `实际 ${idx.length}`);
  const rendered = renderTopicIndex(idx);
  check("索引渲染是一行一话题的紧凑形态", rendered.split("\n").length === idx.length);
  check(
    "索引行不含摘要正文（避免全量常驻）",
    !rendered.includes("多实例下不一致") && !rendered.includes("先上 Redis"),
  );

  // ─── 按需读取 ──
  process.stdout.write("\n── 正文按需（read_thinking 才拉全文）──\n");
  const digestText = renderTopicDigest(readTopic(CHAT, "缓存方案")!);
  check("全文含被否理由", digestText.includes("多实例不一致"));
  check("全文含结论", digestText.includes("先上 Redis"));
  check("取不存在的话题返回 undefined", readTopic(CHAT, "压根没聊过的话题") === undefined);

  // ─── 模式状态 ──
  process.stdout.write("\n── 模式状态（刻意无「结束检测」，靠静默过期）──\n");
  _resetModesForTest();
  check("初始不在脑爆中", activeThinkingTopic(CHAT) === undefined);
  enterThinkingMode(CHAT, "缓存方案");
  check("进入后能取到当前话题", activeThinkingTopic(CHAT) === "缓存方案");
  const future = Date.now() + 31 * 60_000;
  check("静默超 30 分钟后降回索引（不需要检测结束）", activeThinkingTopic(CHAT, future) === undefined);
  enterThinkingMode(CHAT, "鉴权方案");
  exitThinkingMode(CHAT);
  check("主动退出生效", activeThinkingTopic(CHAT) === undefined);

  // ─── 触发预判 ──
  process.stdout.write("\n── 显式信号预判（解决第一轮纪律注不进去）──\n");
  check("识别「脑爆」", looksLikeThinkingRequest("咱们脑爆一下这个功能"));
  check("识别「一起想」", looksLikeThinkingRequest("这个事一起想想"));
  check("识别「帮我梳理」", looksLikeThinkingRequest("帮我梳理下思路"));
  check("识别 brainstorm", looksLikeThinkingRequest("let's brainstorm this"));
  check("普通派活不误判", !looksLikeThinkingRequest("把登录页的报错修一下"));
  check("查询类不误判", !looksLikeThinkingRequest("任务 #12 现在什么状态"));

  // ─── 纪律段落 ──
  process.stdout.write("\n── 纪律段落内容（质量杠杆）──\n");
  const section = thinkingModeSection();
  check("含误判保护（其实要派活时可忽略本段）", section.includes("忽略本段"));
  check("要求发散多方向", section.includes("2-3 个"));
  check("要求说代价", section.includes("代价"));
  check("要求敢质疑前提", section.includes("质疑前提"));
  check("禁止偷偷派活", section.includes("不要偷偷派活"));
  check("允许无结果", section.includes("没有产出也完全可以"));
  const withDigest = thinkingModeSection(readTopic(CHAT, "缓存方案"));
  check("带摘要时注入已否内容防重复论证", withDigest.includes("不要重复讨论已否掉的路"));

  cleanup();
  report();
}

function report(): void {
  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

main();
