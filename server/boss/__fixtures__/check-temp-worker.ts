/**
 * 临时工可见性、生命周期与台账语义的结构性校验（零 LLM，纯断言）。
 *
 * 为什么值得单独测：
 * 1. 临时工对路由不可见**必须是结构性的**——只把它从工具 description 里藏掉是无效的，
 *    同一个 candidates 数组还会喂给 routeAgent、clarify 重路由和改派候选。
 * 2. **提示词不可被销毁**：systemPrompt 从不进日志、只存在 profile 文件里，而它正是
 *    hr 归纳建岗时最需要的素材。任何一条删除路径漏了归档就会永久销毁它。
 * 3. **台账是持久累加器不是滚动窗口**：同类需求可能隔两周才出现第二次，按时间窗永远
 *    凑不满一簇。这条最容易在后续重构里被悄悄改错。
 *
 * 用法：npx tsx server/boss/__fixtures__/check-temp-worker.ts
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgent, listAgents, listRoutableAgents } from "../../agents/registry.js";
import {
  hiredProfilePath,
  listHiredProfiles,
  validateAgentProfile,
  type AgentProfile,
} from "../../config/agent-profile.js";
import { config } from "../../config/index.js";
import { isHighPrivTool } from "../../tools/catalog.js";
import {
  applyProposal,
  createNewHireProposal,
  listProposals,
  pendingNewHireSlugs,
  pendingProposalsCard,
  proposalKind,
  rejectProposal,
  revertProposal,
} from "../proposals.js";
import {
  clusterDigest,
  clusterPending,
  listLedger,
  recordRelease,
  ripeClusters,
} from "../temp-ledger.js";
import { taskManager as tm } from "../task-manager.js";
import {
  capabilitySlug,
  hireTempWorker,
  listTempProfiles,
  releaseTempWorker,
  reviveTempWorker,
  sweepTempWorkers,
  touchTempWorker,
} from "../temp-worker.js";
import { dropChatTasks } from "../store.js";
import { dropChatWorkbench } from "../../core/workbench.js";

const CHAT = "fixture:temp-worker";
const CAP = "接口签名类源码的提取与整理";
/** 一个真实存在、非敏感的目录，用来验收 readRoots 校验 */
const FIXTURE_ROOT = join(config.knowledgeDir);
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

function makeTask(agentName: string) {
  return tm.create({
    channel: "cli",
    chatId: CHAT,
    chatType: "private",
    ownerSenderId: "tester",
    ownerSenderName: "测试用户",
    agentName,
    prompt: "整理一份接口签名清单",
  }).task;
}

function hire(capability: string, taskId: string, extra: Partial<Parameters<typeof hireTempWorker>[0]> = {}) {
  return hireTempWorker({
    capability,
    hiredFor: `按能力域「${capability}」干一件具体的活`,
    description: "临时协助：按能力域完成一次性任务",
    systemPrompt: `你是临时协助人员，负责「${capability}」这类活。产出 markdown 结论。`,
    hiredBy: "boss",
    taskId,
    chatId: CHAT,
    ...extra,
  });
}

/** 台账是只追加文件，测试要在自己的记录上断言 → 用可识别前缀，收尾时清掉 */
function cleanup(): void {
  for (const p of listTempProfiles()) releaseTempWorker(p.id);
  for (const t of tm.allTasks().filter((t) => t.chatId === CHAT)) tm.cancel(CHAT, t.id);
  for (const p of listProposals("pending")) {
    if (proposalKind(p) === "new_hire") rejectProposal(p.id, "测试收尾");
  }
  purgeLedger();
}

const LEDGER = join(config.runtimeDir, "temp-ledger.jsonl");

function writeLedger(entries: ReturnType<typeof listLedger>): void {
  writeFileSync(LEDGER, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf-8");
}

/** 只清本测试造出来的台账行（chatId 认领），别动用户真实记录 */
function purgeLedger(): void {
  writeLedger(listLedger().filter((e) => e.chatId !== CHAT));
}

function mine() {
  return listLedger().filter((e) => e.chatId === CHAT);
}

function main(): void {
  cleanup();

  process.stdout.write("\n── slug 归一化 ──\n");
  check("同义写法归一到同一 slug", capabilitySlug("API 签名/整理") === capabilitySlug("api 签名 整理"));

  process.stdout.write("\n── 招聘 ──\n");
  const task = makeTask("assistant");
  const hired = hire(CAP, task.id);
  check("招聘成功", hired.ok, hired.ok ? "" : hired.reason);
  if (!hired.ok) {
    cleanup();
    report();
    return;
  }
  const id = hired.id;

  process.stdout.write("\n── 可见性隔离（核心不变量）──\n");
  check("listRoutableAgents 不含临时工", !listRoutableAgents().some((a) => a.name === id));
  check("listAgents 不含临时工", !listAgents().some((a) => a.name === id));
  check("listHiredProfiles 默认不含临时工", !listHiredProfiles().some((p) => p.id === id));
  check(
    "listHiredProfiles({includeTemp}) 能取到",
    listHiredProfiles({ includeTemp: true }).some((p) => p.id === id),
  );
  check("getAgent 仍能解析（绑定任务/取消/看板详情要用）", Boolean(getAgent(id)));

  process.stdout.write("\n── 默认只读 ──\n");
  const profile = getAgent(id)?.profile;
  const tools = profile?.tools ?? [];
  const hiredPrompt = profile?.systemPrompt ?? "";
  check("不填 tools 就是只读", !tools.some(isHighPrivTool), JSON.stringify(tools));
  check("含只读工具", tools.includes("Read"));
  check("只读岗取缺省额度 30", profile?.maxTurns === 30, String(profile?.maxTurns));
  check("type=simple（没给 steps）", profile?.type === "simple");
  check("不写 routeHint（不进路由，写了只会招来误路由）", !profile?.routeHint);
  // 直接测校验函数：HireInput 里没有 routeHint 字段，入口已结构性挡住这条路，
  // 走 hire() 测不到规则本身，还会白占一个 live 名额把后面的上限断言带崩。
  // 这条规则曾经反向失效——strict 一律要求 routeHint，于是**每次**招临时工都被判非法，
  // 功能整体作废，线索只有 hire 返回的一句「配置非法」。
  const tempBase: Partial<AgentProfile> = {
    id: "tmp-validate-probe",
    displayName: "探针",
    description: "校验用",
    systemPrompt: "x",
    temp: { capability: CAP, capabilitySlug: capabilitySlug(CAP), hiredFor: "x", hiredBy: "boss" },
  } as Partial<AgentProfile>;
  check("临时工不带 routeHint 即合法", validateAgentProfile(tempBase, true).length === 0, JSON.stringify(validateAgentProfile(tempBase, true)));
  check(
    "临时工带 routeHint 被拒",
    validateAgentProfile({ ...tempBase, routeHint: "【选我当】x。【别选我当】y。" }, true).some((e) =>
      e.includes("routeHint"),
    ),
  );
  check(
    "正式岗位反过来仍必须带 routeHint",
    validateAgentProfile({ ...tempBase, temp: undefined }, true).some((e) => e.includes("routeHint")),
  );
  check("不参与复盘", profile?.retro?.enabled === false);
  check("记录归属为 temp", getAgent(id)?.agentKind() === "temp");

  process.stdout.write("\n── 按需授权：高权限必须带 readRoots ──\n");
  const t1 = makeTask("assistant");
  const noRoots = hire("配置改动与构建验证", t1.id, { tools: ["Read", "Write", "Bash"] });
  check("给了 Write/Bash 但没给 readRoots → 拒绝", !noRoots.ok);
  check(
    "拒绝原因说清怎么办",
    !noRoots.ok && /readRoots/.test(noRoots.reason) && /只读/.test(noRoots.reason),
    noRoots.ok ? "" : noRoots.reason,
  );
  for (const bad of ["/", process.env.HOME ?? "~", config.runtimeDir, config.serviceRoot]) {
    const r = hire("配置改动与构建验证", t1.id, { tools: ["Write"], readRoots: [bad] });
    check(`readRoots 拒收敏感根：${bad}`, !r.ok, r.ok ? "居然过了" : "");
  }
  const okRoots = hire("配置改动与构建验证", t1.id, {
    tools: ["Read", "Grep", "Write", "Edit", "Bash"],
    readRoots: [FIXTURE_ROOT],
  });
  check("高权限 + 合法 readRoots → 招成", okRoots.ok, okRoots.ok ? "" : okRoots.reason);
  if (okRoots.ok) {
    const p = getAgent(okRoots.id)?.profile;
    check("Bash 真落到白名单里（不再被代码抹掉）", (p?.tools ?? []).includes("Bash"));
    check("readRoots 落盘且已展开为绝对路径", (p?.readRoots ?? [])[0] === FIXTURE_ROOT);
    check("有写权限的岗步数额度更高", p?.maxTurns === 60, String(p?.maxTurns));
    releaseTempWorker(okRoots.id);
  }

  process.stdout.write("\n── 步数额度按任务调配 ──\n");
  for (const [label, requested, expected] of [
    ["招聘方给的合法额度被采纳", 45, 45],
    ["超过硬上限被夹到 80", 500, 80],
    ["低于下限的非法值回落缺省", 3, 30],
  ] as const) {
    const t = makeTask("assistant");
    const r = hire("按规模调配额度的活", t.id, { maxTurns: requested });
    check(label, r.ok && getAgent(r.id)?.profile.maxTurns === expected, r.ok ? String(getAgent(r.id)?.profile.maxTurns) : r.reason);
    if (r.ok) releaseTempWorker(r.id);
  }

  process.stdout.write("\n── 闸门：只剩每任务 1 个 + live 上限 ──\n");
  check("同一任务不得再招", !hire("另一种能力域", task.id).ok);

  const task2 = makeTask("assistant");
  const sameCap = hire(CAP, task2.id);
  check("同一能力域**照常**招（同类反复出现是归纳信号，不是错误）", sameCap.ok, sameCap.ok ? "" : sameCap.reason);

  const task3 = makeTask("assistant");
  const third = hire("第三种能力域", task3.id);
  const task4 = makeTask("assistant");
  const overflow = hire("第四种能力域", task4.id);
  check(
    `live 达上限 ${config.tempWorker.maxLive} 时拒绝`,
    third.ok && !overflow.ok,
    overflow.ok ? "居然招成了" : overflow.reason,
  );
  check("拒绝原因说得出怎么办", !overflow.ok && /上限|释放|取消/.test(overflow.reason));
  if (sameCap.ok) releaseTempWorker(sameCap.id);
  if (third.ok) releaseTempWorker(third.id);

  process.stdout.write("\n── 释放：归档保真 + 台账落行 ──\n");
  const before = mine().length;
  tm.update(CHAT, task.id, { agentName: id });
  tm.markDone(CHAT, task.id, "整理出 42 个接口签名");
  tm.update(CHAT, task.id, { reviewRounds: 2, bossAssists: 1 });
  releaseTempWorker(id);
  check("释放后 getAgent 拿不到", !getAgent(id));
  const entries = mine();
  check("台账多了一行", entries.length === before + 1);
  const row = entries.find((e) => e.tempId === id);
  check("记录带能力域与 slug", row?.capability === CAP && row?.capabilitySlug === capabilitySlug(CAP));
  check("记录初始状态 pending", row?.status === "pending");
  check("效果快照取自 Task", row?.effectiveness.reviewRounds === 2 && row?.effectiveness.bossAssists === 1);
  check("结论摘要落库", Boolean(row?.effectiveness.resultSummary?.includes("42")));
  check("归档路径落库", Boolean(row?.archivedSpec));
  let archived: AgentProfile | undefined;
  if (row?.archivedSpec) {
    try {
      archived = JSON.parse(readFileSync(row.archivedSpec, "utf-8")) as AgentProfile;
    } catch {
      /* 下一条断言会报出来 */
    }
  }
  check(
    "归档里的 systemPrompt 与招聘时逐字一致（辞退路径**不经** TTL 清理）",
    archived?.systemPrompt === hiredPrompt,
    `${archived?.systemPrompt?.slice(0, 40)} ≠ ${hiredPrompt.slice(0, 40)}`,
  );

  process.stdout.write("\n── 累加器语义（不是滚动窗口）──\n");
  const slug = capabilitySlug(CAP);
  const cnt = () => clusterPending().find((c) => c.capabilitySlug === slug)?.count ?? 0;
  purgeLedger();
  const base = { capability: CAP, capabilitySlug: slug, hiredFor: "x", chatId: CHAT, hiredBy: "boss" as const };
  recordRelease({ ...base, tempId: "tmp-a", taskId: "t1" });
  recordRelease({ ...base, tempId: "tmp-b", taskId: "t2" });
  check("2 条时闸门不触发", ripeClusters().every((c) => c.capabilitySlug !== slug), String(cnt()));
  // 第 3 条造成 30 天前：滚动窗口实现会漏掉它，累加器不会
  const old = recordRelease({ ...base, tempId: "tmp-c", taskId: "t3" });
  patchLedgerTs(old.id, Date.now() - 30 * 24 * 3600 * 1000);
  check("隔 30 天补上第 3 条仍触发", ripeClusters().some((c) => c.capabilitySlug === slug), String(cnt()));

  for (let i = 0; i < 200; i++) {
    recordRelease({ ...base, tempId: `tmp-bulk-${i}`, taskId: `tb${i}` });
  }
  const digest = clusterDigest(ripeClusters());
  check(
    "200 条同类仍只有一组（摘要体积随能力域个数而非记录数增长）",
    (digest.match(/^### /gm) ?? []).length === 1,
    String((digest.match(/^### /gm) ?? []).length),
  );

  process.stdout.write("\n── 消费语义：批准才消费，驳回不销毁证据 ──\n");
  const ids = mine().filter((e) => e.status === "pending").map((e) => e.id).slice(0, 3);
  const draft: AgentProfile = {
    id: "fixture-signature-lister",
    displayName: "签名整理员",
    description: "从源码提取接口签名并整理成清单",
    routeHint: "【选我当】需要从源码里提取接口签名做成清单时。【别选我当】要改代码或跑命令时。",
    type: "simple",
    systemPrompt: "你负责接口签名类源码的提取与整理，产出 markdown 清单。",
    workspace: "auto",
  };
  const proposal = createNewHireProposal({
    profileDraft: draft,
    ledgerIds: ids,
    capabilitySlugs: [slug],
    summary: "这类活已由临时工接了 3 次，建议设固定岗位",
    evidence: ["t1", "t2", "t3"],
  });
  check("提案 kind=new_hire", proposalKind(proposal) === "new_hire");
  check("提案后记录是 proposed 而非被删", mine().filter((e) => ids.includes(e.id) && e.status === "proposed").length === 3);
  check("proposed 不再参与聚类", !clusterPending().some((c) => c.entries.some((e) => ids.includes(e.id))));
  check("闸门自去重认得这个能力域", pendingNewHireSlugs().has(slug));
  check("建岗提案不支持回退", !revertProposal(proposal.id).ok);
  const card = pendingProposalsCard();
  check(
    "卡片按建岗措辞而非改提示词",
    `${card?.title ?? ""}`.includes("建岗") && !`${card?.text ?? ""}`.includes("提示词"),
    JSON.stringify(card),
  );

  const applied = applyProposal(proposal.id);
  check("批准后新员工落盘", applied.ok, applied.message);
  check("新岗位用**新 id**（是多个临时工的合并，不继承任一身份）", applied.agentId === draft.id);
  check("新岗位立刻可路由", listRoutableAgents().some((a) => a.name === draft.id));
  check("批准后那批记录标 consumed", mine().filter((e) => ids.includes(e.id) && e.status === "consumed").length === 3);

  // 驳回路径：另起一批记录
  purgeLedger();
  const dIds = [1, 2, 3].map((i) => recordRelease({ ...base, tempId: `tmp-d${i}`, taskId: `td${i}` }).id);
  const p2 = createNewHireProposal({
    profileDraft: { ...draft, id: "fixture-lister-2" },
    ledgerIds: dIds,
    capabilitySlugs: [slug],
    summary: "第二次提",
  });
  rejectProposal(p2.id);
  check("驳回后记录标 declined（不销毁证据）", mine().filter((e) => e.status === "declined").length === 3);
  check("declined 不再参与聚类", !ripeClusters().some((c) => c.capabilitySlug === slug));
  for (let i = 0; i < 3; i++) recordRelease({ ...base, tempId: `tmp-e${i}`, taskId: `te${i}` });
  check("新产生 3 条同类能重新触发（真实需求不会被 declined 永久压住）", ripeClusters().some((c) => c.capabilitySlug === slug));
  removeEmployee(draft.id);

  process.stdout.write("\n── TTL 清理 ──\n");
  const task5 = makeTask("assistant");
  const hired3 = hire("日志汇总类", task5.id);
  if (!hired3.ok) {
    check("TTL 段前置招聘", false, hired3.reason);
    cleanup();
    report();
    return;
  }
  // 真实流程里招完人会把任务交接给他（boss.ts 的 opHireTempWorker 负责，
  // 因为改派要动 markRunning/runWorker）。这里模拟那一步，否则测不到活跃任务闸门。
  tm.update(CHAT, task5.id, { agentName: hired3.id });
  check("交接后任务归属临时工", tm.get(CHAT, task5.id)?.agentName === hired3.id);
  touchTempWorker(hired3.id);
  const future = Date.now() + (config.tempWorker.ttlHours + 1) * 3600 * 1000;
  check("有活跃任务时跳过不清", !sweepTempWorkers(future).includes(hired3.id));

  const promptOf3 = getAgent(hired3.id)?.profile.systemPrompt ?? "";
  tm.cancel(CHAT, task5.id);
  check("无活跃任务且过期 → 释放", sweepTempWorkers(future).includes(hired3.id));
  check("释放后 getAgent 拿不到", !getAgent(hired3.id));
  const swept = mine().find((e) => e.tempId === hired3.id);
  let archived3: AgentProfile | undefined;
  if (swept?.archivedSpec) {
    try {
      archived3 = JSON.parse(readFileSync(swept.archivedSpec, "utf-8")) as AgentProfile;
    } catch {
      /* 断言会报 */
    }
  }
  check("TTL 路径同样归档且提示词逐字一致", archived3?.systemPrompt === promptOf3);

  process.stdout.write("\n── 从归档复活（重试失败任务用）──\n");
  check("复活前 getAgent 拿不到（已被 TTL 清走）", !getAgent(hired3.id));
  const revive1 = reviveTempWorker(hired3.id);
  check("复活成功", revive1.ok, revive1.reason);
  check("复活后 getAgent 能拿到", !!getAgent(hired3.id));
  check("复活后提示词与释放前逐字一致", getAgent(hired3.id)?.profile.systemPrompt === promptOf3);
  check("再次复活幂等（已在名册直接 ok）", reviveTempWorker(hired3.id).ok);
  check("不存在的存档复活失败", !reviveTempWorker("tmp-nonexistent-zzzz").ok);
  releaseTempWorker(hired3.id);

  cleanup();
  report();
}

/** 直接改台账某行的时间戳：用来验证「不是滚动窗口」 */
function patchLedgerTs(id: string, ts: number): void {
  writeLedger(listLedger().map((e) => (e.id === id ? { ...e, ts } : e)));
}

function removeEmployee(id: string): void {
  const path = hiredProfilePath(id);
  if (existsSync(path)) unlinkSync(path);
}

function report(): void {
  const total = pass + fails.length;
  process.stdout.write(`\n━━━ ${pass}/${total} 通过 ━━━\n`);
  if (fails.length) process.stdout.write(`未通过：${fails.join(", ")}\n`);
  process.exit(fails.length ? 1 : 0);
}

/**
 * 收尾清掉本 fixture 自己那个 chat 的任务库。
 *
 * **必须挂 process exit，不能用 finally**：实测 finally 清完之后还有写入把文件重建出来
 * —— check-handoff 的交接决策是 `void` 异步发出的，main 的 promise 结算后它们仍在跑，
 * 每次 tm.update 都会重新 persist。exit 事件在事件循环排空后触发，那时才真的没人再写。
 *
 * **只删自己这一个 chat**，绝不按 `fixture_*` 前缀批量删：并行跑多个 fixture 时
 * 那样会互相把对方的库删掉，表现是随机的断言失败，极难定位。
 */
process.on("exit", () => {
  dropChatTasks(CHAT);
  // 任务走终态钩子时会连带落一条工作台记录，只清任务库会留下 workbench 残留
  dropChatWorkbench(CHAT);
});

main();
