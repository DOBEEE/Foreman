import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { config } from "../../config/index.js";
import type { DingTalkCreds } from "./creds.js";

/**
 * 钉钉图片发送支持：把 agent 产出的本地截图（playwright 验证图等）自动上传成 media_id，
 * 让 markdown 里的 `![alt](本地路径)` 在钉钉里能真正显示出来。
 *
 * 上传接口用的是**老版 oapi**（与 v1.0 的 accessToken 不同源）：
 *   POST https://oapi.dingtalk.com/media/upload?access_token=<oapi>&type=image
 *   multipart 字段名 media → { errcode: 0, media_id: "@lALPxxx" }
 * 发送时 markdown 写 `![alt](media_id)` 即内嵌显示。
 *
 * 凭据由调用方按渠道实例传入：token 与 media_id 都是**按企业隔离**的，
 * 多实例下共用一份缓存会把 A 企业的 media_id 发到 B 企业的群里（显示为空图）。
 */

const OAPI = "https://oapi.dingtalk.com";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 钉钉图片上限 20MB

/** 只允许图片扩展名——防止 agent 误写路径把敏感文件（密钥/日志）上传出去 */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/** markdown 图片语法：![alt](path)，只取本地路径（非 http/media_id） */
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/** clientId → oapi token（按企业分键，不能共用） */
const oapiTokens = new Map<string, { token: string; expiresAt: number }>();
/** `clientId:内容 hash` → media_id，避免同一张图重复上传（media_id 按企业隔离，故带 clientId） */
const mediaCache = new Map<string, string>();

async function getOapiToken(c: DingTalkCreds): Promise<string | undefined> {
  const cached = oapiTokens.get(c.clientId);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  try {
    const res = await fetch(
      `${OAPI}/gettoken?appkey=${encodeURIComponent(c.clientId)}&appsecret=${encodeURIComponent(c.clientSecret)}`,
    );
    const body = (await res.json()) as {
      errcode?: number;
      access_token?: string;
      expires_in?: number;
      errmsg?: string;
    };
    if (body.errcode !== 0 || !body.access_token) {
      console.warn(`[dingtalk-media] 取 oapi token 失败: ${body.errcode} ${body.errmsg ?? ""}`);
      return undefined;
    }
    oapiTokens.set(c.clientId, {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000,
    });
    return body.access_token;
  } catch (e) {
    console.warn("[dingtalk-media] 取 oapi token 异常:", e);
    return undefined;
  }
}

function contentTypeOf(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return "image/jpeg";
  }
}

/** 上传一张本地图片，返回 media_id；不合格/失败返回 undefined */
export async function uploadImage(
  creds: DingTalkCreds,
  filePath: string,
): Promise<string | undefined> {
  const ext = extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return undefined;
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (!existsSync(abs)) return undefined;
  let size = 0;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return undefined;
    size = st.size;
  } catch {
    return undefined;
  }
  if (size === 0 || size > MAX_IMAGE_BYTES) {
    console.warn(`[dingtalk-media] 跳过 ${abs}（大小 ${size} 字节，超出 0~20MB）`);
    return undefined;
  }

  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return undefined;
  }
  const cacheKey = `${creds.clientId}:${createHash("sha1").update(buf).digest("hex")}`;
  const cached = mediaCache.get(cacheKey);
  if (cached) return cached;

  const token = await getOapiToken(creds);
  if (!token) return undefined;

  try {
    const form = new FormData();
    form.append(
      "media",
      new Blob([new Uint8Array(buf)], { type: contentTypeOf(ext) }),
      abs.split("/").pop() ?? "image",
    );
    const res = await fetch(`${OAPI}/media/upload?access_token=${token}&type=image`, {
      method: "POST",
      body: form,
    });
    const body = (await res.json()) as { errcode?: number; media_id?: string; errmsg?: string };
    if (body.errcode !== 0 || !body.media_id) {
      console.warn(`[dingtalk-media] 上传失败 ${abs}: ${body.errcode} ${body.errmsg ?? ""}`);
      return undefined;
    }
    mediaCache.set(cacheKey, body.media_id);
    return body.media_id;
  } catch (e) {
    console.warn(`[dingtalk-media] 上传异常 ${abs}:`, e);
    return undefined;
  }
}

/**
 * 把 markdown 中 `![alt](本地图片路径)` 的路径替换成 media_id，让图片在钉钉里显示。
 * - 只处理 markdown 图片语法（不动纯文本里的路径：用户有时只想知道路径）
 * - 只处理本地图片扩展名（http(s) 链接与已是 media_id 的原样保留）
 * - 上传失败保持原文，绝不因此丢消息
 */
export async function processLocalImages(
  creds: DingTalkCreds,
  text: string,
): Promise<string> {
  if (!text.includes("![")) return text;

  const matches = [...text.matchAll(MD_IMAGE_RE)];
  if (matches.length === 0) return text;

  let out = text;
  for (const m of matches) {
    const [full, alt, rawPath] = m;
    const p = rawPath.trim().replace(/\\ /g, " ");
    // 跳过网络图 / 已是 media_id（钉钉 media_id 以 @ 开头）
    if (/^https?:\/\//i.test(p) || p.startsWith("@")) continue;
    if (!IMAGE_EXTS.has(extname(p).toLowerCase())) continue;
    const mediaId = await uploadImage(creds, p);
    if (mediaId) out = out.replace(full, `![${alt}](${mediaId})`);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// 接收方向：用户发来的图片 → 下载到本地，供 agent 用 Read 工具查看
// ════════════════════════════════════════════════════════════════════════

/** 用户发来的图片落盘目录（按 chat 分桶） */
export const inboundDir = join(config.runtimeDir, "inbound");

/** downloadCode 换临时下载 URL（POST /v1.0/robot/messageFiles/download） */
async function getFileDownloadUrl(
  c: DingTalkCreds,
  downloadCode: string,
): Promise<string | undefined> {
  try {
    // 下载接口用新版 v1.0 token
    const tk = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey: c.clientId, appSecret: c.clientSecret }),
    });
    const tokenBody = (await tk.json()) as { accessToken?: string };
    if (!tokenBody.accessToken) return undefined;

    const res = await fetch("https://api.dingtalk.com/v1.0/robot/messageFiles/download", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": tokenBody.accessToken,
      },
      body: JSON.stringify({ downloadCode, robotCode: c.robotCode }),
    });
    const body = (await res.json()) as { downloadUrl?: string };
    if (!body.downloadUrl) {
      console.warn(`[dingtalk-media] downloadCode 换 URL 失败: ${JSON.stringify(body).slice(0, 200)}`);
      return undefined;
    }
    return body.downloadUrl;
  } catch (e) {
    console.warn("[dingtalk-media] 换取 downloadUrl 异常:", e);
    return undefined;
  }
}

const MAX_TEAM_FILE_BYTES = 6 * 1024 * 1024;

/** 下载普通附件。当前只允许团队包，避免把机器人变成任意文件落盘入口。 */
export async function downloadInboundTeamFile(
  creds: DingTalkCreds,
  downloadCode: string,
  chatId: string,
  originalName?: string,
): Promise<{ name: string; path: string; mimeType?: string; size: number } | undefined> {
  const url = await getFileDownloadUrl(creds, downloadCode);
  if (!url) return undefined;
  const safeName = (originalName || "team.ait-team")
    .replace(/[^\w.()\-\u4e00-\u9fff]/g, "_")
    .slice(0, 120);
  if (!safeName.toLowerCase().endsWith(".ait-team")) {
    console.warn(`[dingtalk-media] 拒绝非 .ait-team 附件：${safeName}`);
    return undefined;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载返回 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_TEAM_FILE_BYTES) {
      throw new Error(`附件大小 ${buf.length} 不在允许范围内`);
    }
    const bucket = chatId.replace(/[^\w-]/g, "_").slice(0, 60);
    const dir = join(inboundDir, bucket);
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID().slice(0, 6)}-${safeName}`;
    const abs = join(dir, name);
    writeFileSync(abs, buf);
    return {
      name: safeName,
      path: abs,
      ...(res.headers.get("content-type") ? { mimeType: res.headers.get("content-type")! } : {}),
      size: buf.length,
    };
  } catch (error) {
    console.warn("[dingtalk-media] 下载团队包失败:", error);
    return undefined;
  }
}

function extFromContentType(ct: string | null): string {
  if (!ct) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("bmp")) return ".bmp";
  return ".png";
}

/**
 * 下载用户发来的图片到本地，返回绝对路径（失败返回 undefined）。
 * 落在 <runtimeDir>/inbound/<chatId 分桶>/ 下，文件名带时间戳避免冲突。
 */
export async function downloadInboundImage(
  creds: DingTalkCreds,
  downloadCode: string,
  chatId: string,
): Promise<string | undefined> {
  const url = await getFileDownloadUrl(creds, downloadCode);
  if (!url) return undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载返回 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
      console.warn(`[dingtalk-media] 收到的图片大小异常：${buf.length} 字节`);
      return undefined;
    }
    const bucket = chatId.replace(/[^\w-]/g, "_").slice(0, 60);
    const dir = join(inboundDir, bucket);
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID().slice(0, 6)}${extFromContentType(res.headers.get("content-type"))}`;
    const abs = join(dir, name);
    writeFileSync(abs, buf);
    return abs;
  } catch (e) {
    console.warn("[dingtalk-media] 下载收到的图片失败:", e);
    return undefined;
  }
}
