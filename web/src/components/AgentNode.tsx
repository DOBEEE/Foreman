import { memo } from "react";
import { Handle, Position } from "reactflow";
import { Avatar, faceOfNode } from "../agent-face";
import type { AgentNode as AgentNodeT, BossNode, SquadLink, TempNode } from "../types";

const HIGH_PRIV = new Set(["Write", "Edit", "Bash", "Task", "TodoWrite"]);

/** 员工当前的运行时状态（来自会话面板轮询数据） */
export interface AgentRuntimeStatus {
  running: number;
  waiting: number;
  queued: number;
}

interface Props {
  data: (AgentNodeT | BossNode | TempNode) & {
    runtime?: AgentRuntimeStatus;
    /** 本次编队里的参与情况（有则显示编队徽标） */
    squad?: SquadLink;
    /** 编队里此刻在跑的步骤（编队步骤不建 boss Task，任务列表里看不到） */
    squadWork?: { kind: "执行" | "评审"; title: string };
  };
  selected: boolean;
}

/** 编队徽标：把「谁在做哪一步」放到卡片上，组织图连线就不必再挂长标签 */
function SquadBadge({ link }: { link: SquadLink }) {
  if (link.active) {
    const { kind, title } = link.active;
    const short = title.length > 16 ? `${title.slice(0, 16)}…` : title;
    return (
      <div className={`squad-badge active ${kind === "评审" ? "review" : "exec"}`}>
        <span className="dot pulse" />
        {kind} · {short}
      </div>
    );
  }
  const counts = [
    link.exec ? `执行 ×${link.exec}` : "",
    link.review ? `评审 ×${link.review}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return <div className="squad-badge">🤝 {counts} · 已完成</div>;
}

/** 剩余存活时间：TTL 到点即释放，这信息对用户有用（要不要现在追问他） */
function remainingLabel(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "即将释放";
  const mins = Math.round(ms / 60000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m 后释放` : `${mins}m 后释放`;
}

export const AgentNode = memo(({ data, selected }: Props) => {
  const isBoss = data.kind === "boss";
  const isTemp = data.kind === "temp";
  const face = faceOfNode(data);
  const agent = !isBoss ? (data as AgentNodeT) : undefined;
  // 编队组长：介于 boss 与员工之间的编排角色，单独视觉
  const isLead = data.id === "lead";
  const hasHighPriv = agent ? (agent.tools ?? []).some((t) => HIGH_PRIV.has(t)) : false;
  const rt = data.runtime;
  const squadBusy = Boolean(data.squadWork);
  const state = rt?.waiting
    ? "waiting"
    : rt?.running
      ? "running"
      : rt?.queued
        ? "queued"
        : squadBusy
          ? "running"
          : "idle";

  return (
    <div
      className={`rf-card ${isBoss ? "boss" : ""} ${isLead ? "lead" : ""} ${isTemp ? "temp" : ""} ${selected ? "selected" : ""} state-${state}`}
    >
      {!isBoss && <Handle type="target" position={Position.Top} />}
      {isBoss && <Handle type="source" position={Position.Bottom} />}
      {/* boss 的左右出口：正下方是队长卡片，派工弧从底部出发必然穿过它
          （实测每条有 26/200 采样点埋在卡片里）→ 指向左右两簇的边改从侧面出 */}
      {isBoss && <Handle id="left" type="source" position={Position.Left} />}
      {isBoss && <Handle id="right" type="source" position={Position.Right} />}
      {!isBoss && <Handle type="source" position={Position.Bottom} />}

      <div className="avatar-row">
        <div className="avatar">
          <Avatar face={face} size={46} />
          {state === "running" && <span className="pulse-ring" />}
        </div>
        <div className="ident">
          <div className="nick">{data.name}</div>
          <div className="id">{data.id === "__boss__" ? "boss" : data.id}</div>
        </div>
        {!isBoss && agent && (
          <span
            className={`type-pill ${isTemp ? "type-temp" : isLead ? "type-lead" : `type-${agent.type}`}`}
          >
            {isTemp
              ? "临时"
              : isLead
                ? "编队组长"
                : agent.type === "sop"
                  ? "组长"
                  : agent.group === "exec"
                    ? "内置"
                    : "员工"}
          </span>
        )}
      </div>

      <div className="desc">
        {isBoss ? (data as BossNode).description : agent?.description}
      </div>

      {data.squad && <SquadBadge link={data.squad} />}

      <div className="footer">
        <div className="badges">
          {!isBoss && agent?.workspacePolicy && agent.workspacePolicy !== "shared" && (
            <span className="chip">🗂 {agent.workspacePolicy}</span>
          )}
          {!isBoss && (agent?.maxParallel ?? 1) > 1 && (
            <span
              className="chip clone"
              title={`影分身：同一会话内可同时开 ${agent?.maxParallel} 个分身各干一件活，每个分身有独立工作目录，互不干扰`}
            >
              🌀 影分身 ×{agent?.maxParallel}
            </span>
          )}
          {hasHighPriv && <span className="chip warn">⚠️ 高权限</span>}
          {agent?.manualOnly && <span className="chip dim">手动</span>}
          {agent?.retro?.enabled && <span className="chip">📝 复盘</span>}
          {isLead && <span className="chip lead">🤝 可组队</span>}
          {isTemp && agent?.temp && (
            <span className="chip dim" title={`绑定任务 #${agent.temp.taskId}`}>
              ⏳ {remainingLabel(agent.temp.expiresAt)}
            </span>
          )}
        </div>
        <div className={`status ${state}`}>
          {state === "idle" && <span>空闲</span>}
          {state === "running" && (
            <>
              <span className="dot pulse" />
              {rt && rt.running > 0 ? `${rt.running} 运行中` : "编队执行中"}
            </>
          )}
          {state === "waiting" && (
            <>
              <span className="dot" />
              {rt!.waiting} 待确认
            </>
          )}
          {state === "queued" && (
            <>
              <span className="dot" />
              {rt!.queued} 排队
            </>
          )}
          {rt && rt.queued > 0 && state !== "queued" && (
            <span className="q-tail">+{rt.queued}</span>
          )}
        </div>
      </div>
    </div>
  );
});
AgentNode.displayName = "AgentNode";
