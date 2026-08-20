import { buildSystemPrompt } from "../boss-agent.js";

const prompt = buildSystemPrompt({
  waiting: [],
  active: [],
  finished: [],
  channel: "dingtalk",
  chatType: "private",
  senderName: "测试用户",
});

const lines = prompt.split("\n");
process.stdout.write(`行数：${lines.length}\n字符：${prompt.length}\n`);
process.stdout.write(`粗估 token（中文按 1 字≈1 tok）：~${Math.round(prompt.length)}\n\n`);

// 结构校验：该出现的段落都在，且顺序正确（人格 → 怎么说话 → 能力边界 → 事实来源 → 决策）
const want = ["## 怎么说话", "## 你的能力边界", "## 事实来源", "## 每收到一条消息", "## 团队名册"];
let cursor = -1;
let ok = true;
for (const h of want) {
  const at = prompt.indexOf(h);
  if (at < 0) {
    process.stdout.write(`❌ 缺段落：${h}\n`);
    ok = false;
  } else if (at < cursor) {
    process.stdout.write(`❌ 段落顺序错位：${h}\n`);
    ok = false;
  } else {
    cursor = at;
    process.stdout.write(`✅ ${h}（第 ${prompt.slice(0, at).split("\n").length} 行）\n`);
  }
}

// 反例对照必须成对出现，否则「怎么说话」那层等于只剩说教
const pairs = prompt.split("\n").filter((l) => l.trim().startsWith("❌") || l.trim().startsWith("✅"));
process.stdout.write(`\n正反例行数：${pairs.length}（应为偶数且 ≥4）\n`);
if (pairs.length < 4 || pairs.length % 2 !== 0) ok = false;

// 已合并的重复禁止句不该再出现
for (const dead of ["不要凭印象编", "张冠李戴", "## 回复要求", "不要粉饰"]) {
  if (prompt.includes(dead)) {
    process.stdout.write(`❌ 残留已合并的旧表述：${dead}\n`);
    ok = false;
  }
}

// 硬约束必须原样保留
for (const hard of ["绝不谎报", "你**只能做两件事**", "而是你确实做不到"]) {
  if (!prompt.includes(hard)) {
    process.stdout.write(`❌ 硬约束丢失：${hard}\n`);
    ok = false;
  }
}

// 人格层的具体杠杆要真的注入（否则说明覆盖层还是旧的）
for (const voice of ["用「你」不用「您」", "口语化短句"]) {
  if (!prompt.includes(voice)) {
    process.stdout.write(`❌ 人格未生效（覆盖层可能仍是旧文案）：${voice}\n`);
    ok = false;
  }
}

process.stdout.write(ok ? "\n━━━ 渲染校验通过 ━━━\n" : "\n━━━ 渲染校验失败 ━━━\n");
