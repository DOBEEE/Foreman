import { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  type Edge,
  type Node,
} from "reactflow";
import { api } from "../api";
import { invalidateAgentDirectory } from "../agent-face";
import type {
  AgentProfile,
  AgentNode as AgentNodeT,
  Squad,
  TempNode,
  SquadLink,
  Task,
  TeamGraph,
  ToolCatalog,
} from "../types";
import { AgentNode, type AgentRuntimeStatus } from "../components/AgentNode";
import { AgentEditor } from "../components/AgentEditor";
import { AgentTasks } from "../components/AgentTasks";

/** 分组框：把内置岗位圈成「总裁办」，纯装饰（不可选不可拖，置于卡片之下） */
function GroupBox({ data }: { data: { label: string; hint?: string } }) {
  return (
    <div className="org-group">
      {/* 派工边落在整簇顶部中点：boss→每个员工是「谁都能派」的全局事实，
          逐个连线不增加信息量，只会把图变成一团横线（见 layoutGraph 的说明） */}
      <Handle type="target" position={Position.Top} className="org-group-handle" />
      <div className="org-group-title">{data.label}</div>
      {data.hint && <div className="org-group-hint">{data.hint}</div>}
    </div>
  );
}

const nodeTypes = { agent: AgentNode, groupBox: GroupBox };

const NODE_W = 260;
/**
 * 卡片高度 = 布局行距的基数，也通过 `--rf-card-h` 注入给 CSS 固定卡片高度（见 styles.css）。
 *
 * 190 是「描述 2 行 + 徽标 2 行」的实测值。原先写 156，比**任何**一张卡都矮
 * （实测最矮 165、带两行徽标的 189），后果有三个且都是静默的：
 * 同排卡片底边参差、行间距被高卡吃掉（44 → 11）、分组框按 156 算高度所以内容顶出框外 33px。
 *
 * 两边同源靠的是「TS 注入 CSS 变量」而不是人去记两处数字 —— 卡片内容以后加一行，
 * 只要把这个数改了，布局与卡片会一起跟上。
 */
const NODE_H = 190;
const BOSS_W = 280;
const COL_GAP = 26;
const ROW_GAP = 44;
const TIER_GAP = 78;
/**
 * 队长档 → 员工档的额外净空。
 *
 * 用 TIER_GAP 时队长卡片底部到分组框顶部只剩 36px（78 − GROUP_PAD 22 − GROUP_TITLE_H 20），
 * 连线没有下降空间，只能沿着分组框顶边横着走，和箱体虚线边框糊在一起。
 * 队长是所有动态连线的发起点，这一档下面必须留出让曲线散开的余量。
 */
const LEAD_TO_STAFF_GAP = 170;
const CLUSTER_GAP = 90;
/**
 * 每排几张。
 *
 * 用 4 而不是 3：总裁办现有 7 人，按 3 折行是 3/3/1 —— 最后一排孤零零一张挂在左边，
 * 是这版布局看起来"乱"的主因。按 4 折行是 4+3，而**少一张的那排在半列错开下恰好就是
 * 居中位置**（pitch/2 = 143，少一张空出 286，正好一半），所以看着是刻意的对称而非漏排。
 *
 * 还有一层：第三排在这套间距下**没法**靠横向错开避开上方的卡片 —— 第 1 排的缝正是第 2 排的
 * 卡心、反之亦然，两排的缝互补，第三排无论怎么挪都会压在某张卡下面（连线被卡片遮没）。
 * 所以只要能压到两排，就别让第三排出现。
 */
const PER_ROW = 4;
const GROUP_PAD = 22;
const GROUP_TITLE_H = 20;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 一簇员工：按 PER_ROW 折行排列，返回各节点坐标与整簇包围盒。
 *
 * 偶数行（第 2、4 排…）横向错开**半个列距**：不错开时第二排的卡片正好压在第一排某张卡的
 * 正下方（retro 在 default 下、tooler 在 hr 下、coder 在 alert-diagnosis 下），
 * 从上方队长下来的连线只能穿过第一排那张卡片，而 React Flow 的边画在节点**之下** ——
 * 线就被卡片挡没了。错开半列后，通往第二排的下行段正好落在第一排两卡之间的缝里。
 */
function layoutCluster(
  ids: string[],
  originX: number,
  originY: number,
): { pos: Map<string, { x: number; y: number }>; box: Box } {
  const pos = new Map<string, { x: number; y: number }>();
  const pitch = NODE_W + COL_GAP;
  const rowOffset = (r: number): number => (r % 2 === 1 ? pitch / 2 : 0);
  ids.forEach((id, i) => {
    const c = i % PER_ROW;
    const r = Math.floor(i / PER_ROW);
    pos.set(id, {
      x: originX + rowOffset(r) + c * pitch,
      y: originY + r * (NODE_H + ROW_GAP),
    });
  });
  const rows = Math.max(1, Math.ceil(ids.length / PER_ROW));
  // 包围盒按各行实际右边界取最大值——错开的行会比第一行更靠右，否则会顶出框外
  let width = NODE_W;
  for (let r = 0; r < rows; r++) {
    const count = Math.min(PER_ROW, ids.length - r * PER_ROW);
    if (count <= 0) continue;
    width = Math.max(width, rowOffset(r) + count * NODE_W + (count - 1) * COL_GAP);
  }
  return {
    pos,
    box: {
      x: originX,
      y: originY,
      w: width,
      h: rows * NODE_H + (rows - 1) * ROW_GAP,
    },
  };
}

/**
 * 手工分层布局（比 dagre 可控：分组框位置确定、组长自成一档）：
 *   boss（顶） → 队长 lead（第二档，编排角色） → 员工两簇（总裁办 / 员工）
 */
function layoutGraph(
  graph: TeamGraph,
  runtimeByAgent: Map<string, AgentRuntimeStatus>,
  squads: Squad[],
  runningTaskIds: Set<string>,
): {
  nodes: Node[];
  edges: Edge[];
  liveSquads: number;
  /** 谁此刻在编队里干活（卡片状态与抽屉也读它） */
  squadWork: Map<string, { kind: "执行" | "评审"; title: string }>;
} {
  const agents = graph.nodes.filter((n): n is AgentNodeT => n.kind === "agent");
  const hasLead = agents.some((a) => a.id === "lead");
  const execIds = agents.filter((a) => a.group === "exec" && a.id !== "lead").map((a) => a.id);
  const staffIds = agents.filter((a) => a.group !== "exec").map((a) => a.id);
  // 在岗临时工自成一簇：他们不在员工名册里（路由看不见），混进「员工」框会误导
  const tempIds = graph.nodes.filter((n): n is TempNode => n.kind === "temp").map((n) => n.id);

  // 运行时判定：谁「此刻」真在跑（running）/ 真在忙（running 或 waiting）
  const engaged = (id: string): boolean => {
    const rt = runtimeByAgent.get(id);
    return Boolean(rt && (rt.running > 0 || rt.waiting > 0));
  };
  const running = (id: string): boolean => (runtimeByAgent.get(id)?.running ?? 0) > 0;

  // 编队参与度（按目标员工聚合）：卡片徽标与连线共用同一份数据。
  //
  // 存活判据是两个条件的合取，两个都不能少：
  //   1. 组长这个任务本身还在 running —— squad 状态是落在磁盘上的断点文件，任务被打断/
  //      放弃后会残留（phase 仍是 executing），照文件推断就会让队长金线常亮、idle 员工挂着
  //      跳动的徽标。任务态是唯一能识破残留的信号。
  //   2. 组长落盘声明了 running 步骤 —— 编队步骤走 runDelegate 直接跑 agent，**不建 boss
  //      Task**，所以「哪个员工在忙」在任务列表里查不到。早先这里拿 boss 任务态去判编队成员，
  //      恒为 false，编队一跑起来连线反而整簇消失（本次要修的就是这个）。
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const links = new Map<string, SquadLink>();
  /** 谁此刻在编队里干活：卡片状态与抽屉也读它（编队步骤不建 boss Task，任务列表看不到） */
  const squadWork = new Map<string, { kind: "执行" | "评审"; title: string }>();
  let liveSquads = 0;
  for (const squad of squads) {
    const active = runningTaskIds.has(squad.taskId) ? squad.running : undefined;
    if (!active) continue; // 残留 / 未开工 / 已收尾的编队：整簇忽略
    liveSquads++;
    for (const step of squad.plan?.steps ?? []) {
      for (const [who, kind] of [
        [step.employee, "执行"],
        [step.reviewer, "评审"],
      ] as const) {
        if (!who || who === "temp" || !nodeIds.has(who)) continue;
        const link = links.get(who) ?? { exec: 0, review: 0 };
        if (kind === "执行") link.exec++;
        else link.review++;
        // 只点亮组长声明的那一个人 —— 同一步的执行者与评审人可能是同一人，靠 role 区分
        const isActive =
          active.stepId === step.id &&
          active.employee === who &&
          kind === (active.role === "review" ? "评审" : "执行");
        if (isActive && !link.active) {
          link.active = { kind, title: step.title || step.id };
          squadWork.set(who, { kind, title: step.title || step.id });
        }
        links.set(who, link);
      }
    }
  }

  const employeeY = hasLead
    ? NODE_H + TIER_GAP + NODE_H + LEAD_TO_STAFF_GAP
    : NODE_H + TIER_GAP;
  const exec = layoutCluster(execIds, 0, employeeY);
  const staffX = execIds.length ? exec.box.x + exec.box.w + CLUSTER_GAP : 0;
  const staff = layoutCluster(staffIds, staffX, employeeY);
  const tempX = staffIds.length
    ? staff.box.x + staff.box.w + CLUSTER_GAP
    : execIds.length
      ? exec.box.x + exec.box.w + CLUSTER_GAP
      : 0;
  const temp = layoutCluster(tempIds, tempX, employeeY);

  const rightEdge = tempIds.length
    ? temp.box.x + temp.box.w
    : staffIds.length
      ? staff.box.x + staff.box.w
      : exec.box.x + exec.box.w;
  const totalW = Math.max(rightEdge || NODE_W, BOSS_W);
  const centerX = totalW / 2;

  const posOf = (id: string): { x: number; y: number } => {
    if (id === "__boss__") return { x: centerX - BOSS_W / 2, y: 0 };
    if (id === "lead") return { x: centerX - NODE_W / 2, y: NODE_H + TIER_GAP };
    return (
      exec.pos.get(id) ??
      staff.pos.get(id) ??
      temp.pos.get(id) ?? { x: centerX - NODE_W / 2, y: employeeY }
    );
  };

  const nodes: Node[] = [];

  // 分组框（置于卡片之下）
  const groupBox = (id: string, box: Box, label: string, hint: string): Node => ({
    id,
    type: "groupBox",
    position: { x: box.x - GROUP_PAD, y: box.y - GROUP_PAD - GROUP_TITLE_H },
    data: { label, hint },
    style: {
      width: box.w + GROUP_PAD * 2,
      height: box.h + GROUP_PAD * 2 + GROUP_TITLE_H,
    },
    draggable: false,
    selectable: false,
    zIndex: -1,
  });
  if (execIds.length > 0) {
    nodes.push(groupBox("__exec_group__", exec.box, "总裁办", "内置岗位 · 随代码发布 · 不可删"));
  }
  if (staffIds.length > 0) {
    nodes.push(
      groupBox("__staff_group__", staff.box, "员工", "出厂预置 + 招聘 · 可改可删"),
    );
  }
  if (tempIds.length > 0) {
    nodes.push(
      groupBox("__temp_group__", temp.box, "临时工", "无人可派时现招 · 用完即释放 · 不进路由"),
    );
  }

  for (const n of graph.nodes) {
    nodes.push({
      id: n.id,
      type: "agent",
      position: posOf(n.id),
      data: {
        ...n,
        runtime: runtimeByAgent.get(n.id),
        squad: links.get(n.id),
        squadWork: squadWork.get(n.id),
      },
      draggable: true,
    });
  }

  /**
   * 边的取舍：**只画有信息量的关系**。
   *
   * 之前 boss 向每个员工各连一条 dispatch 边（9~10 条），但「主管可以派给任何员工」
   * 是全局事实、不是某一条关系——逐条画不增加任何信息，却让十来根线从同一个点出发、
   * 横跨上千像素、互相交叉，还要穿过分组框边框与第一排卡片，图直接糊成一片。
   * 而分组框本身已经表达了「这一簇都可派」。
   *
   * 所以常设分发边收敛成「boss → 分组框」各一条；手动触发型岗位的区分不会丢——
   * 卡片上本来就有「手动」chip（AgentNode）。逐节点的边只留给真正有信息量的三类：
   *   1. boss → 队长：唯一的编排关系，金色主干
   *   2. boss → 在岗临时工：虚线，且只对其绑定任务成立（不是常设分发）
   *   3. 队长 → 编队参与者：动态，编队进行时才有
   */
  const edges: Edge[] = [];

  /**
   * 运行时事实：谁「此刻」真在被使唤。
   *
   * 组织图的所有静态边（boss→簇、boss→队长、SOP 委派）都只是「谁**可以**被派」的
   * 结构关系，不是「谁**正在**被派」。以前它们一律画成实心亮线，于是队长那条金线
   * 常驻高亮 → 看着像队长一直在干活；而 boss 直接派下去的员工反倒没有任何连线指向它。
   * 这里以「真在推进的编队」为准（links 已剔除残留编队）：
   *   - activeSquadIds：正被点亮为进行中的编队参与者（squad 边覆盖它们）
   *   - directWorkers：真在忙、又不属于活跃编队的员工 → boss 直派的「活线」
   */
  const activeSquadIds = new Set(
    [...links].filter(([, l]) => l.active).map(([who]) => who),
  );
  const leadActive = engaged("lead") || activeSquadIds.size > 0;
  const directWorkers = agents
    .filter((a) => a.id !== "lead" && !activeSquadIds.has(a.id) && engaged(a.id))
    .map((a) => a.id);
  const anyLive = leadActive || directWorkers.length > 0;

  // 1) boss → 各簇（把 9 条同质边压成 2~3 条）
  //
  // 用贝塞尔而非 smoothstep：boss 在正中、分组框在左右且很宽，直角折线会先下行、
  // 再拉一条横跨整幅图的长横线，正好贴着分组框的虚线边框走（撞色，看着像边框不像连线），
  // 还和编队边挤在同一条走廊里。曲线从 boss 底部直接弯向各箱顶部，走向一眼可读。
  // 不挂文字标签：两条同质边挂两个相同的「派工」纯属噪声，箭头与分层已经说明关系。
  const clusterEdge = (groupId: string, sourceHandle: "left" | "right"): Edge => ({
    id: `dispatch:${groupId}`,
    source: "__boss__",
    sourceHandle,
    target: groupId,
    type: "bezier",
    style: { stroke: "#3a4358", strokeWidth: 1.5, strokeDasharray: "5 5" },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#3a4358" },
  });
  if (execIds.length > 0) edges.push(clusterEdge("__exec_group__", "left"));
  if (staffIds.length > 0) edges.push(clusterEdge("__staff_group__", "right"));

  // 2) 逐节点的边：只有 boss→队长（编排主干）与 boss→临时工（任务级绑定）
  for (const e of graph.edges) {
    if (e.kind === "delegate") {
      edges.push({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "smoothstep",
        animated: true,
        style: { stroke: "#c9b6ff", strokeWidth: 2 },
        label: e.accept ? `↳ ${e.stepId} · 验收` : `↳ ${e.stepId}`,
        labelStyle: { fontSize: 10, fill: "#c9b6ff", fontWeight: 600 },
        labelBgStyle: { fill: "#1e2432", fillOpacity: 0.9 },
        labelBgPadding: [4, 6] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: { type: MarkerType.ArrowClosed, color: "#c9b6ff" },
      });
      continue;
    }
    if (e.temp === true) {
      edges.push({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "smoothstep",
        style: { stroke: "#7b8a99", strokeWidth: 1, strokeDasharray: "3 6", opacity: 0.7 },
        label: "临时",
        labelStyle: { fontSize: 9, fill: "#c3cdd8", fontWeight: 500 },
        labelBgStyle: { fill: "#1e2432", fillOpacity: 0.7 },
        labelBgPadding: [2, 5] as [number, number],
        labelBgBorderRadius: 3,
        markerEnd: { type: MarkerType.ArrowClosed, color: "#7b8a99" },
      });
      continue;
    }
    // 常设 dispatch：只保留 boss→队长，其余已由分组框的「派工」边代表
    if (e.to !== "lead") continue;
    // 队长这条金线只有在队长真活跃时才点亮；否则收敛成一条很淡的结构线，
    // 不再常驻高亮误导「队长一直在工作」
    edges.push({
      id: e.id,
      source: e.from,
      target: e.to,
      type: "smoothstep",
      animated: engaged("lead"),
      style: {
        stroke: "#e0a800",
        strokeWidth: leadActive ? 2.5 : 1.5,
        opacity: leadActive ? 0.95 : 0.28,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#e0a800" },
    });
  }

  // 编队边：每个参与员工一条无文字连线（步骤名在卡片徽标上，避免线上标签互压）
  for (const [who, link] of links) {
    const kind = link.active?.kind ?? (link.exec ? "执行" : "评审");
    const color = kind === "评审" ? "#7fd1b9" : "#ffd479";
    edges.push({
      id: `squad:${who}`,
      source: "lead",
      target: who,
      /**
       * 用 bezier，不用 smoothstep。
       *
       * 实测（按路径采样点统计埋在卡片内的比例）：bezier 103 点，smoothstep + offset 260
       * 反而 130 点 —— smoothstep 的水平段固定落在源与目标的 **y 中点**，而那个中点必然
       * 位于第一排卡片的 y 区间内，调 offset 只会把它推得更深，躲不开。
       *
       * 更根本地：从一个居中高处的枢纽连到 3 列网格的**第二排**，不绕开整簇就一定穿过
       * 第一排 —— 那需要真正的避障路由（dagre / elk 级别），换个曲线类型解决不了。
       * 所以策略是「几何上尽量少穿」（错行 + bezier）+「把边层抬到卡片之上，让残留的
       * 穿越是看得见地经过而不是整段消失」（见 styles.css 的 .react-flow__edges）。
       */
      type: "bezier",
      animated: Boolean(link.active),
      style: {
        stroke: color,
        strokeWidth: link.active ? 2.5 : 1.25,
        opacity: link.active ? 1 : 0.3,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color },
    });
  }

  // 活线：boss 直接派下去、正在忙的员工。以前这条关系只由静态的 boss→簇 虚线代表，
  // 于是「boss 现在到底在使唤谁」根本看不出来。用蓝色（与卡片 state-running 的蓝一致）
  // 从 boss 直连该员工，让「活线」和「发亮的卡片」在视觉上是同一件事。
  for (const id of directWorkers) {
    edges.push({
      id: `live:${id}`,
      source: "__boss__",
      target: id,
      type: "bezier",
      animated: running(id),
      style: { stroke: "#6ea8fe", strokeWidth: 2.5, opacity: 0.95 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#6ea8fe" },
      zIndex: 10,
    });
  }

  // 有任何活线（编队 or 直派）时压暗结构线，让「当前在干什么」成为视觉主体。
  // 已经点亮的活线（squad:/live:）与真活跃的 boss→队长 主干不压。
  if (anyLive) {
    for (const e of edges) {
      if (e.id.startsWith("squad:") || e.id.startsWith("live:")) continue;
      if (e.target === "lead" && leadActive) continue;
      e.style = { ...e.style, opacity: Number(e.style?.opacity ?? 1) * 0.3 };
    }
  }

  return { nodes, edges, liveSquads, squadWork };
}

/** 汇总跨所有 chat 的每员工活跃计数 */
function aggregateRuntime(tasksByAgent: Map<string, Task[]>): Map<string, AgentRuntimeStatus> {
  const out = new Map<string, AgentRuntimeStatus>();
  for (const [agent, tasks] of tasksByAgent) {
    const s = { running: 0, waiting: 0, queued: 0 };
    for (const t of tasks) {
      if (t.state === "running") s.running++;
      else if (t.state === "waiting_user") s.waiting++;
      else if (t.state === "queued") s.queued++;
    }
    out.set(agent, s);
  }
  return out;
}

export function OrgChartPage() {
  const [graph, setGraph] = useState<TeamGraph | null>(null);
  const [tasksByAgent, setTasksByAgent] = useState<Map<string, Task[]>>(new Map());
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detail, setDetail] = useState<{
    configurable: boolean;
    config: AgentProfile | null;
    meta: AgentNodeT | TempNode | null;
  } | null>(null);
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [squads, setSquads] = useState<Squad[]>([]);
  const [newMode, setNewMode] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const g = await api.team();
      setGraph(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** 轮询活跃任务：跨全部 chat 拉一遍任务，按 agentName 聚合到 tasksByAgent */
  const refreshRuntime = useCallback(async () => {
    try {
      const { chats } = await api.chats("active");
      const detailLists = await Promise.all(
        chats.map((c) => api.chatTasks(c.chatId).catch(() => ({ tasks: [] as Task[] }))),
      );
      const perAgent = new Map<string, Task[]>();
      for (const { tasks } of detailLists) {
        for (const t of tasks) {
          if (["done", "failed", "cancelled"].includes(t.state)) continue;
          const arr = perAgent.get(t.agentName) ?? [];
          arr.push(t);
          perAgent.set(t.agentName, arr);
        }
      }
      setTasksByAgent(perAgent);
      const { squads: list } = await api.squads().catch(() => ({ squads: [] as Squad[] }));
      setSquads(list);
    } catch {
      /* 忽略：不阻断主视图 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshRuntime();
    void api.toolCatalog().then(setCatalog).catch(() => undefined);
    const t1 = setInterval(refresh, 10000);
    const t2 = setInterval(refreshRuntime, 3000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [refresh, refreshRuntime]);

  const runtime = useMemo(() => aggregateRuntime(tasksByAgent), [tasksByAgent]);

  /** 此刻在跑的任务号：编队存活判据靠它识破「任务已结束但断点文件还在」的残留 */
  const runningTaskIds = useMemo(
    () =>
      new Set(
        [...tasksByAgent.values()]
          .flat()
          .filter((t) => t.state === "running")
          .map((t) => t.id),
      ),
    [tasksByAgent],
  );

  const rf = useMemo(
    () =>
      graph
        ? layoutGraph(graph, runtime, squads, runningTaskIds)
        : {
            nodes: [] as Node[],
            edges: [] as Edge[],
            liveSquads: 0,
            squadWork: new Map<string, { kind: "执行" | "评审"; title: string }>(),
          },
    [graph, runtime, squads, runningTaskIds],
  );

  // 可作为 SOP 委派目标的员工：临时工不算（他随时被释放，指向他的步骤会跑不起来）
  const employeeIds = useMemo(() => {
    return (graph?.nodes ?? [])
      .filter((n): n is AgentNodeT => n.kind === "agent")
      .map((n) => n.id);
  }, [graph]);

  const builtinIds = useMemo(() => {
    return (graph?.nodes ?? [])
      .filter((n): n is AgentNodeT => n.kind === "agent" && n.group === "exec")
      .map((n) => n.id);
  }, [graph]);

  const openDetail = useCallback(
    async (id: string) => {
      if (id === "__boss__") {
        setSelectedId(id);
        const boss = graph?.nodes.find((n) => n.id === "__boss__");
        alert(
          `${boss?.kind === "boss" ? boss.name : "Boss"}\n\n${boss?.kind === "boss" ? boss.description : ""}\n\nboss 身份配置在 server/config/boss.json；团队路由能力是内置逻辑，不通过 dashboard 修改。`,
        );
        setSelectedId(undefined);
        return;
      }
      setSelectedId(id);
      setNewMode(false);
      try {
        const d = await api.agentDetail(id);
        const meta = graph?.nodes.find((n) => n.id === id);
        setDetail({
          configurable: d.configurable,
          config: d.config,
          // 临时工也走只读视图（configurable=false → detail.config 为 null）
          meta: meta && meta.kind !== "boss" ? meta : null,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [graph],
  );

  const onSave = async (cfg: AgentProfile) => {
    if (newMode) await api.createAgent(cfg);
    else await api.updateAgent(cfg);
    invalidateAgentDirectory();
    await refresh();
    setNewMode(false);
    setDetail(null);
    setSelectedId(undefined);
  };

  const onDelete = async () => {
    if (!selectedId) return;
    await api.deleteAgent(selectedId);
    invalidateAgentDirectory();
    await refresh();
    setDetail(null);
    setSelectedId(undefined);
  };

  const closeDrawer = () => {
    setDetail(null);
    setSelectedId(undefined);
    setNewMode(false);
  };

  return (
    <div className="org-page">
      <div className="org-graph">
        <div className="org-toolbar">
          <button
            className="primary"
            onClick={() => {
              setNewMode(true);
              setSelectedId(undefined);
              setDetail({ configurable: true, config: null, meta: null });
            }}
          >
            ➕ 招个新员工
          </button>
          <button onClick={refresh}>🔄 刷新</button>
          {/*
            只做入口、不在这里重建向导：导出/导入是多步事务（预览 → 安全清单 → 确认令牌
            → 应用 → 回滚），实现两份必然漂移，而漂移出来的差异恰好都在安全相关的那几步上。
          */}
          <a className="org-linkbtn" href="/dashboard/settings?tab=team" title="导出可分享的团队配置（不含模型、凭据与本机路径）">
            📤 分享团队
          </a>
          <a className="org-linkbtn" href="/dashboard/settings?tab=team" title="导入 .ait-team 团队配置（先检查、再确认、可回滚）">
            📥 导入团队
          </a>
          <span className="org-hint">
            {runtime.size > 0
              ? `🟢 ${[...runtime.values()].reduce((s, r) => s + r.running, 0)} 运行中 · ${[...runtime.values()].reduce((s, r) => s + r.waiting, 0)} 待确认`
              : "所有员工都空闲"}
            {squads.length > 0 && rf.liveSquads > 0 && (
              <span className="org-hint-squad">🤝 {rf.liveSquads} 个编队进行中</span>
            )}
          </span>
          {error && <span style={{ color: "var(--danger)", marginLeft: 12 }}>{error}</span>}
        </div>
        <ReactFlow
          // 卡片固定高度与布局行距同源：CSS 里读 --rf-card-h（见 styles.css .rf-card）
          style={{ ["--rf-card-h" as string]: `${NODE_H}px` }}
          nodes={rf.nodes.map((n) => ({ ...n, selected: n.id === selectedId }))}
          edges={rf.edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => void openDetail(node.id)}
          onPaneClick={() => closeDrawer()}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          minZoom={0.3}
          maxZoom={1.5}
        >
          <Background color="#262b38" gap={24} size={1.2} />
          <Controls />
        </ReactFlow>
      </div>
      {detail && (
        <div className="org-drawer">
          {newMode ? (
            <AgentEditor
              initial={null}
              isNew
              catalog={catalog}
              employeeIds={employeeIds}
              builtinIds={builtinIds}
              onSave={onSave}
              onCancel={closeDrawer}
            />
          ) : detail.configurable && detail.config ? (
            <>
              <AgentTasks
                agentId={detail.config.id}
                tasks={tasksByAgent.get(detail.config.id) ?? []}
                squadWork={rf.squadWork.get(detail.config.id)}
              />
              <AgentEditor
                initial={detail.config}
                isNew={false}
                catalog={catalog}
                employeeIds={employeeIds.filter((id) => id !== selectedId)}
                builtinIds={builtinIds}
                onSave={onSave}
                onCancel={closeDrawer}
                onDelete={onDelete}
              />
            </>
          ) : detail.meta ? (
            <>
              <AgentTasks
                agentId={detail.meta.id}
                tasks={tasksByAgent.get(detail.meta.id) ?? []}
                squadWork={rf.squadWork.get(detail.meta.id)}
              />
              <BuiltinView meta={detail.meta} onClose={closeDrawer} />
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function BuiltinView({
  meta,
  onClose,
}: {
  meta: AgentNodeT | TempNode;
  onClose: () => void;
}) {
  return (
    <div>
      <h3>
        {meta.name}{" "}
        <span style={{ color: "var(--text-dim)", fontSize: 12, marginLeft: 6 }}>
          {meta.id}
        </span>
        {meta.kind === "temp" && <span className="badge-temp">临时</span>}
      </h3>
      <div className="meta">
        {meta.kind === "temp"
          ? `临时工（无人可派时现招，绑定任务 #${meta.temp?.taskId ?? "?"}）。会自动释放，不可编辑——要把这类活长期留下来，等系统攒够同类记录后由 hr 提「建岗」提案。`
          : "内置岗位（在代码里维护，dashboard 不可编辑）"}
      </div>
      {meta.kind === "temp" && meta.temp && (
        <>
          <label>能力域</label>
          <div>{meta.temp.capability}</div>
          <label>这次招他来干的活</label>
          <div style={{ color: "var(--text-dim)", whiteSpace: "pre-wrap" }}>{meta.temp.hiredFor}</div>
        </>
      )}
      <label>职责</label>
      <div>{meta.description}</div>
      {meta.routeHint && (
        <>
          <label>路由提示</label>
          <div style={{ color: "var(--text-dim)" }}>{meta.routeHint}</div>
        </>
      )}
      {meta.tools && (
        <>
          <label>可用工具</label>
          <div>{meta.tools.join(", ")}</div>
        </>
      )}
      {meta.manualOnly && (
        <div style={{ color: "var(--warn)", marginTop: 10 }}>
          ⚠️ 手动触发岗位，不参与自动路由
        </div>
      )}
      <div className="actions">
        <button onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}
