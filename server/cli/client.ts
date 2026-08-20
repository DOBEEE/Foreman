/** SSE 客户端：POST /api/agents/:name/run，把 SSE 流解析回归一化事件 */

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface RunRequest {
  prompt: string;
  resume?: string;
  params?: Record<string, unknown>;
}

export async function* runAgentStream(
  baseUrl: string,
  agentName: string,
  request: RunRequest,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const res = await fetch(`${baseUrl}/api/agents/${agentName}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: request.prompt,
      stream: true,
      persistSession: true,
      ...(request.resume ? { resume: request.resume } : {}),
      ...(request.params ? { params: request.params } : {}),
    }),
    signal,
  });
  yield* readSse(res);
}

export interface BossRequest {
  prompt: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
}

/** REPL 模式：POST /api/boss/run（立即返回）；boss 回复经 subscribeBossEvents 推送 */
export async function postBossMessage(
  baseUrl: string,
  request: BossRequest,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/boss/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: request.prompt,
      chatId: request.chatId,
      ...(request.senderId ? { senderId: request.senderId } : {}),
      ...(request.senderName ? { senderName: request.senderName } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`server ${res.status}: ${text.slice(0, 500)}`);
  }
}

/** 常驻订阅：GET /api/boss/events，boss 全部出站消息（ack/进度/待确认/汇报）从这里流出 */
export async function* subscribeBossEvents(
  baseUrl: string,
  chatId: string,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const res = await fetch(
    `${baseUrl}/api/boss/events?chatId=${encodeURIComponent(chatId)}`,
    { signal },
  );
  yield* readSse(res);
}

/** headless 模式：POST /api/boss/run?wait —— SSE 承载 boss 消息，任务收敛后 done */
export async function* runBossWait(
  baseUrl: string,
  request: BossRequest,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const res = await fetch(`${baseUrl}/api/boss/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: request.prompt,
      chatId: request.chatId,
      wait: true,
      ...(request.senderId ? { senderId: request.senderId } : {}),
      ...(request.senderName ? { senderName: request.senderName } : {}),
    }),
    signal,
  });
  yield* readSse(res);
}

async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`server ${res.status}: ${text.slice(0, 500)}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    // SSE 消息以空行分隔
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseSseMessage(raw);
      if (parsed) yield parsed;
    }
  }
}

function parseSseMessage(raw: string): SseEvent | undefined {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // 心跳注释
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return undefined;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return undefined;
  }
}
