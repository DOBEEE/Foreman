import { useEffect, useState } from "react";
import { api } from "../api";
import type { QoderModelOption } from "../types";

/**
 * Qoder 模型档位下拉。
 *
 * 为什么要它：Qoder 的模型标识是它自己的档位/别名（auto / ultimate / qmodel_38max …），
 * 光看输入框没人猜得出能填什么，而且填错要等跑起来才报错。列表从服务端取（带 5 分钟缓存）。
 *
 * 仍保留手填能力（一个 `<input>` + `<datalist>` 而不是纯 `<select>`）：
 * 组织内部模型、新上线档位可能还没进列表，硬锁下拉会把这些场景堵死。
 */
export function QoderModelPicker({
  value,
  onChange,
  placeholder = "留空 = 用 Qoder 服务端默认（auto）",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [models, setModels] = useState<QoderModelOption[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = (refresh = false) => {
    setLoading(true);
    setErr("");
    api
      .qoderModels(refresh)
      .then((r) => setModels(r.models))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => load(false), []);

  const listId = "qoder-models";
  const picked = models.find((m) => m.value === value);

  return (
    <div>
      <input
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m.value} value={m.value}>
            {label(m)}
          </option>
        ))}
      </datalist>
      <div className="hint">
        {loading && "正在取可用模型…"}
        {err && `取模型列表失败：${err}（仍可手填）`}
        {!loading && !err && picked && label(picked)}
        {/* 填了但不在列表里：大概率是拼错，但也可能是列表还没收录，所以只提示不阻止 */}
        {!loading && !err && !picked && value && "⚠️ 不在可用列表中（可能拼写有误）"}
        {!loading && !err && !value && `${models.length} 个可选档位`}
        {!loading && (
          <>
            {" · "}
            <button type="button" className="link" onClick={() => load(true)}>
              刷新
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** 一行摘要：倍率与上下文是选型时最关心的两个数 */
function label(m: QoderModelOption): string {
  const bits = [m.displayName, `(${m.value})`];
  if (m.isDefault) bits.push("· 默认");
  if (m.priceFactor != null) bits.push(`· ${m.priceFactor}x 积分`);
  if (m.maxInputTokens) bits.push(`· ${Math.round(m.maxInputTokens / 1000)}k 上下文`);
  if (m.isReasoning) bits.push("· reasoning");
  if (m.source && m.source !== "system") bits.push(`· ${m.source}`);
  return bits.join(" ");
}
