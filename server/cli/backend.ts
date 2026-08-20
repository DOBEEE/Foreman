import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../api/http.js";

export interface LocalBackend {
  /** CLI 自己访问用的地址（始终回环，即使实际绑在 0.0.0.0） */
  url: string;
  /** 真实在听的端口。调用方别再用 new URL(url).port 反解 */
  port: number;
  /** 真实绑定地址（用于「已对局域网开放」提示） */
  host: string;
  /** 请求过的固定端口；与 port 不同即发生了回退 */
  requestedPort?: number;
  /** 是否因端口被占而回退到了随机端口 */
  fellBack: boolean;
  close(): Promise<void>;
}

export interface BackendOptions {
  /** 监听端口：省略/0=随机端口（仅本地）；指定端口用于对外 HTTP 服务 */
  port?: number;
  /** 监听地址：默认 127.0.0.1（仅回环）；对外服务传 0.0.0.0 */
  host?: string;
  /**
   * 端口被占/无权限时退到随机端口，而不是抛错。
   * 交互式 CLI 传 true（多开一个终端不该起不来）；守护进程不传 ——
   * 落在随机端口上的守护进程没人找得到，硬失败才是对的。
   */
  fallbackToRandomPort?: boolean;
}

/** 只有这两类错误值得换端口重试；其余（配置错、权限外的系统错）照常抛 */
const FALLBACK_CODES = new Set(["EADDRINUSE", "EACCES"]);

/**
 * 监听一次，成败都收干净。
 *
 * 为什么不用 `Promise.race([once(listening), once(error)])`：race 里输掉的那个
 * `once(server, "error")` 会一直挂着，运行期再出 error 就变成**没人接的 rejection**
 * （crash-guard 会记一条、还会给 boss 报一次假崩溃）。开了端口回退之后，
 * 第一次尝试的 EADDRINUSE 从异常变成了**常规事件**，这个隐患会被稳定触发。
 */
function listenOnce(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      // 监听成功后把 error 交给长期日志：既不留悬着的 rejection，
      // 也避免「error 事件没有监听者」被 Node 升级成 uncaughtException
      server.on("error", (e) => console.error("[backend] HTTP 服务运行期错误:", e));
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

/**
 * CLI 模式：同进程起 HTTP 服务（与 serve 用的是同一个 createApp，看板行为完全一致）。
 * 默认随机端口 + 回环；传 port 时绑定固定端口，可选被占时回退。
 */
export async function startLocalBackend(
  opts: BackendOptions = {},
): Promise<LocalBackend> {
  // 同一个 app 可以反复 listen：app.listen() 每次新建一个 http.Server，重试不用重建 app
  const app = createApp();
  const host = opts.host ?? "127.0.0.1";
  const requested = opts.port ?? 0;

  let server: Server;
  let fellBack = false;
  try {
    server = await listenOnce(app, requested, host);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!opts.fallbackToRandomPort || requested === 0 || !FALLBACK_CODES.has(code ?? "")) {
      throw code === "EADDRINUSE"
        ? new Error(`端口 ${requested} 已被占用（${host}:${requested}）`)
        : error;
    }
    console.warn(
      `[backend] ${host}:${requested} ${code === "EACCES" ? "无权限绑定" : "已被占用"}，改用随机端口`,
    );
    // 失败的 server 从未 listening，不要 close（会抛 ERR_SERVER_NOT_RUNNING），直接丢弃
    server = await listenOnce(app, 0, host); // 随机端口再失败就不是端口问题了，照常抛
    fellBack = true;
  }

  const { port } = server.address() as AddressInfo;
  // 真实端口交给引导层：纯 CLI 是随机端口，而 runtime 抛「缺凭据」时够不到这里的局部变量，
  // 只能拿 config.port 猜 —— 那会把用户指向一个没有服务的端口
  process.env.FOREMAN_DASHBOARD_PORT = String(port);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    host,
    requestedPort: opts.port,
    fellBack,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
