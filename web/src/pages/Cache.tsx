import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { CacheStats, CacheStatsRow, CacheTaskRow } from "../types";

/**
 * Token 用量 + prompt cache 命中。
 *
 * 为什么值得一个独立页面：缓存失效是**静默**的——不报错，只是每次调用按全价重算。
 * 真实事故：换到 VercelRuntime 后 cache_control 一个都没传，命中率从 87.3% 掉到 1.5%、
 * 每 run 等效输入从 15 万涨到 94 万，一路无人察觉，直到某天日额度被打满。
 * 这一页就是那类回归的探测器。
 */

/** 读写比低于这个值，缓存开始亏本（1.25w + 0.1r < w + r 的解） */
const BREAK_EVEN_RATIO = 0.278;

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** 成本倍数的健康度：越接近 1.00 说明缓存越没起作用 */
function costClass(row: CacheStatsRow): string {
  if (row.costMultiple >= 0.9) return "bad";
  if (row.costMultiple >= 0.6) return "warn";
  return "good";
}

/** token 明细的公共列。agent 表和任务表共用，保证两处口径一致 */
function TokenCells({ row }: { row: CacheStatsRow }) {
  return (
    <>
      <td>{fmt(row.freshInput)}</td>
      <td>{fmt(row.cacheWrite)}</td>
      <td className="miss">{fmt(row.missInput)}</td>
      <td className="hit">{fmt(row.cacheRead)}</td>
      <td>{fmt(row.outputTokens)}</td>
      <td>{fmt(row.totalTokens)}</td>
      <td
        className={row.cacheWrite > 0 && row.readWriteRatio < BREAK_EVEN_RATIO ? "bad" : ""}
      >
        {row.cacheWrite > 0 ? row.readWriteRatio.toFixed(2) : "—"}
      </td>
      <td>{pct(row.hitRate)}</td>
      <td className={costClass(row)}>{row.costMultiple.toFixed(2)}x</td>
    </>
  );
}

function TokenHead({ first }: { first: string }) {
  return (
    <tr>
      <th>{first}</th>
      <th>runs</th>
      <th>平均步数</th>
      <th>未命中·全价</th>
      <th>未命中·写缓存</th>
      <th>未命中合计</th>
      <th>命中·读缓存</th>
      <th>输出</th>
      <th>token 合计</th>
      <th>读写比</th>
      <th>命中率</th>
      <th>成本倍数</th>
    </tr>
  );
}

export function CachePage() {
  const [days, setDays] = useState(7);
  const [stats, setStats] = useState<CacheStats | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async (d: number) => {
    try {
      setStats(await api.cacheStats(d));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh(days);
  }, [days, refresh]);

  if (error) return <div className="cache-page">读取失败：{error}</div>;
  if (!stats) return <div className="cache-page">加载中…</div>;

  const t = stats.total;
  return (
    <div className="cache-page">
      <div className="cache-head">
        <h2>Token 用量与缓存命中</h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>近 1 天</option>
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
          <option value={60}>近 60 天</option>
        </select>
        <span className="spacer" />
        <span className="hint">{stats.totalRuns} 次有用量记录的 run</span>
      </div>

      <div className="cache-cards">
        <div className={`cache-card ${costClass(t)}`}>
          <div className="cache-card-num">{t.costMultiple.toFixed(2)}x</div>
          <div className="cache-card-label">等效输入成本</div>
          <div className="cache-card-sub">1.00x = 缓存完全没起作用</div>
        </div>
        <div className="cache-card">
          <div className="cache-card-num">{pct(t.hitRate)}</div>
          <div className="cache-card-label">缓存命中率</div>
          <div className="cache-card-sub">
            命中 {fmt(t.cacheRead)} · 未命中 {fmt(t.missInput)}
          </div>
        </div>
        <div className="cache-card">
          <div className="cache-card-num">{fmt(t.totalTokens)}</div>
          <div className="cache-card-label">token 合计</div>
          <div className="cache-card-sub">
            输入 {fmt(t.totalInput)} · 输出 {fmt(t.outputTokens)}
          </div>
        </div>
        <div className="cache-card">
          <div className="cache-card-num">
            {stats.ttlSplitAvailable ? pct(stats.ttl1hShare) : "—"}
          </div>
          <div className="cache-card-label">1h TTL 写入占比</div>
          <div className="cache-card-sub">
            {stats.ttlSplitAvailable
              ? "长档位是否真生效"
              : "当前日志形状拆不出 5m/1h，无法判定"}
          </div>
        </div>
      </div>

      <h3 className="cache-section">按 agent</h3>
      <table className="cache-table">
        <thead>
          <TokenHead first="agent" />
        </thead>
        <tbody>
          {stats.agents.map((a) => (
            <tr key={a.key}>
              <td>{a.label}</td>
              <td>{a.runs}</td>
              <td>{a.avgSteps.toFixed(1)}</td>
              <TokenCells row={a} />
            </tr>
          ))}
          <tr className="cache-total">
            <td>合计</td>
            <td>{t.runs}</td>
            <td>{t.avgSteps.toFixed(1)}</td>
            <TokenCells row={t} />
          </tr>
        </tbody>
      </table>

      <h3 className="cache-section">
        按任务
        <span className="hint">
          {stats.tasks.length < stats.taskCount
            ? `共 ${stats.taskCount} 个，按 token 合计取前 ${stats.tasks.length}`
            : `共 ${stats.taskCount} 个`}
        </span>
      </h3>
      {stats.tasks.length === 0 ? (
        <p className="cache-note">窗口内没有带 taskId 的 run（闲聊类对话不派任务）。</p>
      ) : (
        <table className="cache-table">
          <thead>
            <TokenHead first="任务" />
          </thead>
          <tbody>
            {stats.tasks.map((task: CacheTaskRow) => (
              <tr key={task.key}>
                <td>
                  <span className="cache-task-title" title={task.label}>
                    {task.label}
                  </span>
                  <span className="cache-task-meta">
                    #{task.key} · {task.agents.join("、")}
                  </span>
                </td>
                <td>{task.runs}</td>
                <td>{task.avgSteps.toFixed(1)}</td>
                <TokenCells row={task} />
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="cache-note">
        「未命中·写缓存」也是这次没命中（还额外付了 1.25x / 2x 的写入费），
        只有「命中·读缓存」是 0.1x —— 所以写得多不等于省得多。
        读写比 &lt; {BREAK_EVEN_RATIO}（标红）说明这个岗位的缓存写入收不回本，
        它的 <code>cacheRetention</code> 应该保持 <code>short</code>；
        平均步数高的岗位读写比天然高，因为收益主要来自一次 run 内的多步工具循环。
        只给「一小时内确实会被 resume」的常驻岗位配 <code>long</code>。
      </p>
    </div>
  );
}
