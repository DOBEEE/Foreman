import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteExists, knowledgeFilesFromTrace } from "../upgrade.js";
import { config } from "../../config/index.js";

/**
 * 二层升级的两处确定性关卡。
 *
 * 这两处是把「命题人起草」变成可信事实源的全部依据：
 *   - 引文逐字校验：模型编造引文是必然会发生的，而编造的引文会把**正确**的答复
 *     判成幻觉 —— 比没有事实源更坏
 *   - 知识文件来自轨迹：客观事实，不是让模型猜「哪些规约相关」
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}\n`);
  if (ok) pass++;
  else fail++;
}

const root = mkdtempSync(join(tmpdir(), "bench-knowledge-"));
mkdirSync(join(root, "sub"), { recursive: true });
writeFileSync(
  join(root, "agent-base.md"),
  "# agent-base\n\n经验库分两种注入方式：小库全量注入，\n大库只给索引。\n\n阈值由 config.retro 控制。\n",
  "utf-8",
);
writeFileSync(join(root, "sub", "rules.md"), "答复必须标注来源文档名。\n", "utf-8");
writeFileSync(join(root, "..", "outside-secret.txt"), "TOKEN=abc12345678\n", "utf-8");

process.stdout.write("\n── 引文逐字校验 ──\n");
{
  check(
    "原文逐字命中",
    quoteExists(root, "agent-base.md", "小库全量注入"),
  );
  check(
    "跨行引文命中（空白折叠）",
    quoteExists(root, "agent-base.md", "小库全量注入，大库只给索引"),
    "文件里这句被换行断开",
  );
  check(
    "转述不算命中（这正是要拦的）",
    !quoteExists(root, "agent-base.md", "小库会把全部内容注入进去"),
  );
  check(
    "改了标点也不算（事实源不能差不多）",
    !quoteExists(root, "agent-base.md", "小库全量注入; 大库只给索引"),
  );
  check(
    "指错文件不算命中",
    !quoteExists(root, "sub/rules.md", "小库全量注入"),
  );
  check("文件不存在返回 false 而不是抛错", !quoteExists(root, "nope.md", "小库全量注入"));
  check(
    "太短的「引文」不算（命中不说明任何事）",
    !quoteExists(root, "agent-base.md", "阈值"),
  );
  check(
    "路径逃逸被拦（不许去读知识库外的文件）",
    !quoteExists(root, "../outside-secret.txt", "TOKEN=abc12345678"),
  );
}

process.stdout.write("\n── 知识文件来自轨迹 ──\n");
{
  const runRoot = mkdtempSync(join(tmpdir(), "bench-run-"));
  const transcript = join(runRoot, "trace.jsonl");
  const knowledge = config.knowledgeDir;
  writeFileSync(
    transcript,
    [
      JSON.stringify({ seq: 0, t: 1, kind: "text", text: "我查一下" }),
      JSON.stringify({ id: "t1", seq: 1, t: 2, tool: { name: "Read", input: { file_path: join(knowledge, "a.md") } } }),
      JSON.stringify({ id: "t2", seq: 2, t: 3, tool: { name: "Grep", input: { path: join(knowledge, "sub") } } }),
      // 知识库外的路径不该被收进来
      JSON.stringify({ id: "t3", seq: 3, t: 4, tool: { name: "Read", input: { file_path: "/etc/hosts" } } }),
      // 同一文件读两次只算一次
      JSON.stringify({ id: "t4", seq: 4, t: 5, tool: { name: "Read", input: { file_path: join(knowledge, "a.md") } } }),
      "这不是 JSON",
    ].join("\n"),
    "utf-8",
  );

  const files = knowledgeFilesFromTrace(transcript);
  check("取到读过的知识文件", files.includes("a.md"), files.join(","));
  check("目录形式的入参也算", files.includes("sub"), files.join(","));
  check("知识库外的路径不收", !files.some((f) => f.includes("hosts")), files.join(","));
  check("同一文件去重", files.filter((f) => f === "a.md").length === 1);
  check("坏行不影响解析", files.length === 2, `${files.length} 个`);
  check("轨迹不存在时返回空数组", knowledgeFilesFromTrace(join(runRoot, "nope.jsonl")).length === 0);

  rmSync(runRoot, { recursive: true, force: true });
}

rmSync(root, { recursive: true, force: true });
rmSync(join(root, "..", "outside-secret.txt"), { force: true });

process.stdout.write(`\n━━━ ${pass}/${pass + fail} 通过 ━━━\n`);
if (fail > 0) process.exitCode = 1;
