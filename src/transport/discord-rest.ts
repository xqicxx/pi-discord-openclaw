// Discord REST client — ported from openclaw extensions/discord src/internal/rest.ts (笔记 10).
// 零依赖：node 22 原生 fetch。核心：Bot header、v10 API、429 retry-after 解析、超时。
import type { DiscordCreatedMessage, Snowflake } from "./types.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 3;

/** Discord 错误（含 code/message）。 */
export class DiscordApiError extends Error {
  readonly status: number;
  readonly code?: number;
  constructor(status: number, message: string, code?: number) {
    super(message);
    this.name = "DiscordApiError";
    this.status = status;
    this.code = code;
  }
}

/** 429 限流错误（携带 retryAfterMs）。 */
export class DiscordRateLimitError extends Error {
  readonly retryAfterMs: number;
  readonly global: boolean;
  constructor(retryAfterMs: number, global: boolean, message = "rate limited") {
    super(message);
    this.name = "DiscordRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.global = global;
  }
}

export interface DiscordRestOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** 自定义 fetch（测试注入）。 */
  fetch?: typeof fetch;
}

/** 从 429 响应解析 retry-after（header 秒 或 body retry_after 毫秒）。 */
function readRetryAfterMs(res: Response, body: { retry_after?: number; global?: boolean }): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after)) {
    return Math.round(body.retry_after);
  }
  return 1_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DiscordRest {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DiscordRestOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? DISCORD_API_BASE).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** 通用请求：Bot header + JSON + 429 重试（最多 3 次，带 retry-after 退避）。 */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.token}`,
      "Content-Type": "application/json",
      "User-Agent": "pi-discord-openclaw (https://github.com/xqicxx/pi-discord-openclaw)",
    };
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        const data = text ? (JSON.parse(text) as unknown) : undefined;
        if (res.status === 429) {
          const retryAfterMs = readRetryAfterMs(res, (data ?? {}) as { retry_after?: number; global?: boolean });
          if (attempt >= MAX_RATE_LIMIT_RETRIES) {
            throw new DiscordRateLimitError(retryAfterMs, Boolean((data as { global?: boolean })?.global));
          }
          attempt += 1;
          await sleep(retryAfterMs);
          continue;
        }
        if (!res.ok) {
          const errBody = (data ?? {}) as { message?: string; code?: number };
          throw new DiscordApiError(res.status, errBody.message ?? `HTTP ${res.status}`, errBody.code);
        }
        return data as T;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** POST /channels/{id}/messages — 发送消息（返回 message id）。 */
  async createChannelMessage(
    channelId: Snowflake,
    options: { content: string; message_reference?: { message_id: string; fail_if_not_exists?: boolean } },
  ): Promise<DiscordCreatedMessage> {
    return this.request<DiscordCreatedMessage>("POST", `/channels/${channelId}/messages`, options);
  }

  /** PATCH /channels/{id}/messages/{mid} — 编辑消息。 */
  async editChannelMessage(channelId: Snowflake, messageId: Snowflake, content: string): Promise<unknown> {
    return this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, { content });
  }

  /** DELETE /channels/{id}/messages/{mid} — 删除消息。 */
  async deleteChannelMessage(channelId: Snowflake, messageId: Snowflake): Promise<void> {
    await this.request("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  /** PUT /channels/{id}/typing — 打字指示。 */
  async sendChannelTyping(channelId: Snowflake): Promise<void> {
    await this.request("PUT", `/channels/${channelId}/typing`);
  }
}
