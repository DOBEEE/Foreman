/**
 * Qoder runtime 的**外部会话存储**（落盘实现 SDK 的 SessionStore 接口）。
 *
 * 存在意义 —— **不再污染用户本机 IDE 的会话历史**：
 * Qoder CLI 默认把 transcript 落在 `~/.qoder/projects/<cwd 转义>/`，按 cwd 分目录。
 * Foreman 的 worker 常以真实仓库目录当 cwd 跑，于是它的每一轮都写进了用户 IDE 里
 * 同名项目的会话列表（实测 Foreman 仓那个目录被灌了两百多条）。
 *
 * SDK 的 `sessionStore` 正是为此设计：挂上它之后，qodercli 改跑在**临时 QODER_CONFIG_DIR**
 * 里、transcript 镜像到这里，`~/.qoder/projects/` 不再落任何东西；而 `qodercliAuth()`
 * 复用本机登录态照旧（README 示例就是 sessionStore + qodercliAuth 一起用）。
 *
 * 落盘布局（entries 是 append-order 的不透明 JSON，按行存 JSONL）：
 *   <runtimeDir>/qoder-sessions/<projectKey>/<sessionId>.jsonl              主 transcript
 *   <runtimeDir>/qoder-sessions/<projectKey>/<sessionId>/<subpath>.jsonl    子代理 transcript
 *
 * projectKey / sessionId / subpath 都可能含 `/`、`:` 等路径不安全字符，统一做转义；
 * subpath（形如 `subagents/agent-<id>`）保留其层级，逐段转义后再拼。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@qoder-ai/qoder-agent-sdk";
import { config } from "../config/index.js";

/** 把单个路径段转义成文件系统安全名（保留可读性，非法字符换成 `_`） */
function safeSegment(s: string): string {
  return s.replace(/[^\w.-]/g, "_") || "_";
}

/** subpath 逐段转义后重新拼接，保留 `subagents/agent-x` 这样的层级结构 */
function safeSubpath(sub: string): string {
  return sub
    .split("/")
    .filter(Boolean)
    .map(safeSegment)
    .join("/");
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly root: string) {}

  /** projectKey 目录 */
  private projectDir(projectKey: string): string {
    return join(this.root, safeSegment(projectKey));
  }

  /** 某个 key 对应的 .jsonl 文件路径（主 transcript 或子代理 transcript） */
  private filePath(key: SessionKey): string {
    const base = join(this.projectDir(key.projectKey), safeSegment(key.sessionId));
    // 无 subpath = 主 transcript：<sessionId>.jsonl
    // 有 subpath = 子代理：<sessionId>/<subpath>.jsonl（主与子共享 sessionId 目录前缀）
    return key.subpath ? `${join(base, safeSubpath(key.subpath))}.jsonl` : `${base}.jsonl`;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const file = this.filePath(key);
    mkdirSync(dirname(file), { recursive: true });
    // 一次 append 一批，逐条一行；entries 必须保持 append order，故不排序、不去重
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(file, lines, "utf-8");
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const file = this.filePath(key);
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf-8");
    const out: SessionStoreEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as SessionStoreEntry);
      } catch {
        // 坏行跳过而非整份作废：截断/并发写导致的半行不该让整个 resume 失败
      }
    }
    return out;
  }

  async listSessions(
    projectKey: string,
  ): Promise<Array<{ sessionId: string; mtime: number }>> {
    const dir = this.projectDir(projectKey);
    if (!existsSync(dir)) return [];
    const out: Array<{ sessionId: string; mtime: number }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // 主 transcript 是 <sessionId>.jsonl；子代理目录不算独立会话
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = entry.name.slice(0, -".jsonl".length);
      try {
        out.push({ sessionId, mtime: statSync(join(dir, entry.name)).mtimeMs });
      } catch {
        /* 竞态删除：忽略 */
      }
    }
    return out;
  }

  async delete(key: SessionKey): Promise<void> {
    const file = this.filePath(key);
    rmSync(file, { force: true });
    // 删主 transcript 时连带清掉它的子代理目录（<sessionId>/）
    if (!key.subpath) {
      rmSync(join(this.projectDir(key.projectKey), safeSegment(key.sessionId)), {
        recursive: true,
        force: true,
      });
    }
  }

  async listSubkeys(key: Omit<SessionKey, "subpath">): Promise<string[]> {
    const dir = join(this.projectDir(key.projectKey), safeSegment(key.sessionId));
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (abs: string, rel: string): void => {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const childAbs = join(abs, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(childAbs, childRel);
        else if (entry.name.endsWith(".jsonl")) out.push(childRel.slice(0, -".jsonl".length));
      }
    };
    walk(dir, "");
    return out;
  }
}

let singleton: FileSessionStore | undefined;

/**
 * 进程级单例：resume 要能跨轮读到上一轮 append 的 entries，必须同一个实例。
 * 落盘根目录固定在 runtimeDir 下，随 Foreman 运行目录走，不进用户 IDE 的 `~/.qoder`。
 */
export function getQoderSessionStore(): FileSessionStore {
  if (!singleton) singleton = new FileSessionStore(join(config.runtimeDir, "qoder-sessions"));
  return singleton;
}
