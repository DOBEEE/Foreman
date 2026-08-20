import { useNavigate } from "react-router-dom";
import type { Task } from "../types";

interface Props {
  agentId: string;
  tasks: Task[];
  /** 编队里此刻在跑的步骤（编队步骤不建 boss Task，任务列表里看不到） */
  squadWork?: { kind: "执行" | "评审"; title: string };
}

/** 抽屉顶部：该员工当前的运行中 / 待确认 / 排队任务清单，点击跳转到会话面板 */
export function AgentTasks({ agentId, tasks, squadWork }: Props) {
  const navigate = useNavigate();
  const running = tasks.filter((t) => t.state === "running");
  const waiting = tasks.filter((t) => t.state === "waiting_user");
  const queued = tasks.filter((t) => t.state === "queued");
  const total = running.length + waiting.length + queued.length;

  const goto = (chatId: string) => {
    navigate("/sessions", { state: { chatId } });
  };

  return (
    <div className="agent-tasks">
      <div className="at-title">
        当前工作台 · {agentId}
        {squadWork ? "（编队执行中）" : total === 0 ? "（空闲）" : ` · ${total} 项`}
      </div>
      {squadWork && (
        <div className="at-group">
          <div className="at-group-title running">
            🤝 编队 · {squadWork.kind} · {squadWork.title}
          </div>
        </div>
      )}
      {total === 0 && !squadWork && <div className="at-empty">目前没有派给他的活儿</div>}
      {running.length > 0 && (
        <div className="at-group">
          <div className="at-group-title running">🟢 运行中（{running.length}）</div>
          {running.map((t) => (
            <TaskLine key={t.id} task={t} onClick={() => goto(t.chatId)} />
          ))}
        </div>
      )}
      {waiting.length > 0 && (
        <div className="at-group">
          <div className="at-group-title waiting">🟡 等用户确认（{waiting.length}）</div>
          {waiting.map((t) => (
            <TaskLine key={t.id} task={t} onClick={() => goto(t.chatId)} />
          ))}
        </div>
      )}
      {queued.length > 0 && (
        <div className="at-group">
          <div className="at-group-title queued">⏳ 排队中（{queued.length}）</div>
          {queued.map((t) => (
            <TaskLine key={t.id} task={t} onClick={() => goto(t.chatId)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskLine({ task, onClick }: { task: Task; onClick: () => void }) {
  const preview = task.prompt.slice(0, 60) + (task.prompt.length > 60 ? "…" : "");
  const elapsed = Math.floor((Date.now() - task.updatedAt) / 1000);
  return (
    <div className="at-task" title={task.prompt} onClick={onClick}>
      <span className="id">#{task.id}</span>
      <span className="prompt">{preview}</span>
      <span className="time">{elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m`}</span>
    </div>
  );
}
