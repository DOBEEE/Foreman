import { useEffect, useState } from "react";
import { api } from "./api";
import type { TeamNode } from "./types";

/**
 * 员工「面孔」的唯一来源：
 * - 名字：后端下发（boss.json 的 name / profile.displayName），前端不再硬编码
 * - 头像：profile.avatar（emoji 或图片 URL）优先，缺省用这里的内置默认头像
 */
const DEFAULT_FACE: Record<string, { emoji: string; gradient: string }> = {
  __boss__: { emoji: "👑", gradient: "linear-gradient(135deg,#f5b041,#e67e22)" },
  default: { emoji: "🧑‍💻", gradient: "linear-gradient(135deg,#5dade2,#3498db)" },
  coder: { emoji: "👨‍💻", gradient: "linear-gradient(135deg,#48c9b0,#16a085)" },
  "code-review": { emoji: "🔍", gradient: "linear-gradient(135deg,#af7ac5,#8e44ad)" },
  assistant: { emoji: "💁", gradient: "linear-gradient(135deg,#85c1e9,#3498db)" },
  "alert-diagnosis": { emoji: "🚨", gradient: "linear-gradient(135deg,#ec7063,#c0392b)" },
  optimizer: { emoji: "⚙️", gradient: "linear-gradient(135deg,#95a5a6,#7f8c8d)" },
  retro: { emoji: "📝", gradient: "linear-gradient(135deg,#bb8fce,#8e44ad)" },
  hr: { emoji: "👔", gradient: "linear-gradient(135deg,#f8b195,#e67e22)" },
  tooler: { emoji: "🧰", gradient: "linear-gradient(135deg,#7fb3d5,#2874a6)" },
  lead: { emoji: "🎖️", gradient: "linear-gradient(135deg,#ffd479,#e0a800)" },
};

const TYPE_FALLBACK = {
  sop: { emoji: "🎯", gradient: "linear-gradient(135deg,#b299f0,#7d5ed5)" },
  simple: { emoji: "🤖", gradient: "linear-gradient(135deg,#7ed6df,#22a6b3)" },
  builtin: { emoji: "🧑‍💼", gradient: "linear-gradient(135deg,#82ccdd,#60a3bc)" },
  /** 临时工：降饱和的灰蓝，跟正式成员一眼分得开 */
  temp: { emoji: "🧪", gradient: "linear-gradient(135deg,#a9b7c6,#7b8a99)" },
} as const;

/** 面孔类别。temp 不是 profile.type，而是「临时工」这一身份 */
export type FaceKind = "simple" | "sop" | "builtin" | "temp";

export interface Face {
  /** emoji 或图片 URL */
  avatar: string;
  isImage: boolean;
  gradient: string;
}

export function faceOf(id: string, avatar?: string, type: FaceKind = "builtin"): Face {
  // 临时工的 id 是现生成的，DEFAULT_FACE 里不会有；且它的身份优先于 profile.type
  const base = (type === "temp" ? undefined : DEFAULT_FACE[id]) ?? TYPE_FALLBACK[type];
  const custom = avatar?.trim();
  return {
    avatar: custom || base.emoji,
    isImage: Boolean(custom && /^(https?:|data:|\/)/.test(custom)),
    gradient: base.gradient,
  };
}

export function faceOfNode(node: TeamNode): Face {
  if (node.kind === "temp") return faceOf(node.id, node.avatar, "temp");
  return faceOf(node.id, node.avatar, node.kind === "agent" ? node.type : "builtin");
}

/** 头像：自定义图片直接渲染 img，否则渲染 emoji + 渐变底 */
export function Avatar({
  face,
  size = 34,
  className = "",
}: {
  face: Face;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.55) };
  if (face.isImage) {
    return (
      <img className={`face-avatar img ${className}`} style={style} src={face.avatar} alt="" />
    );
  }
  return (
    <span className={`face-avatar ${className}`} style={{ ...style, background: face.gradient }}>
      {face.avatar}
    </span>
  );
}

export interface AgentIdentity {
  name: string;
  face: Face;
  /** 临时工：会话列表 / 流式面板据此加「临时」小标 */
  isTemp: boolean;
}

/** 全站共享的员工名册（名字 + 头像），5 分钟内复用同一份请求结果 */
let cache: { at: number; map: Map<string, AgentIdentity> } | undefined;
let inflight: Promise<Map<string, AgentIdentity>> | undefined;
const TTL = 5 * 60 * 1000;

async function loadDirectory(): Promise<Map<string, AgentIdentity>> {
  if (cache && Date.now() - cache.at < TTL) return cache.map;
  inflight ??= api
    .team()
    .then((g) => {
      const map = new Map<string, AgentIdentity>();
      for (const n of g.nodes) {
        map.set(n.id, { name: n.name, face: faceOfNode(n), isTemp: n.kind === "temp" });
      }
      cache = { at: Date.now(), map };
      return map;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** 员工增删改后清缓存，让新名字/新头像立刻在全站生效 */
export function invalidateAgentDirectory(): void {
  cache = undefined;
}

/** 组件里按 agent id 取名字 + 头像；未加载完时用 id 兜底 */
export function useAgentDirectory(): (id: string) => AgentIdentity {
  const [map, setMap] = useState<Map<string, AgentIdentity>>(cache?.map ?? new Map());
  useEffect(() => {
    let alive = true;
    void loadDirectory().then((m) => {
      if (alive) setMap(m);
    });
    return () => {
      alive = false;
    };
  }, []);
  return (id: string) => map.get(id) ?? { name: id, face: faceOf(id), isTemp: false };
}
