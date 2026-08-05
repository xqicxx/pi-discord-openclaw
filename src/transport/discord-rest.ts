// Discord REST client — ported from openclaw extensions/discord src/internal/rest.ts (笔记 10).
// 零依赖：node 22 原生 fetch。核心：Bot header、v10 API、429 retry-after 解析、超时。
import type { DiscordApplicationCommand, DiscordCreatedMessage, DiscordGuildSummary, Snowflake } from "./types.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 3;

/** Discord 错误（含 code/message/完整 body——body.errors 指明非法字段）。 */
export class DiscordApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly body?: unknown;
  constructor(status: number, message: string, code?: number, body?: unknown) {
    super(message);
    this.name = "DiscordApiError";
    this.status = status;
    this.code = code;
    this.body = body;
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
          const errBody = (data ?? {}) as { message?: string; code?: number; errors?: unknown };
          throw new DiscordApiError(
            res.status,
            errBody.message ?? `HTTP ${res.status}`,
            errBody.code,
            errBody.errors ?? data,
          );
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
    options: { content: string; embeds?: unknown[]; message_reference?: { message_id: string; fail_if_not_exists?: boolean } },
  ): Promise<DiscordCreatedMessage> {
    return this.request<DiscordCreatedMessage>("POST", `/channels/${channelId}/messages`, options);
  }

  /** PATCH /channels/{id}/messages/{mid} — 编辑消息。 */
  async editChannelMessage(channelId: Snowflake, messageId: Snowflake, content: string, embeds?: unknown[]): Promise<unknown> {
    return this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, { content, ...(embeds ? { embeds } : {}) });
  }

  /** DELETE /channels/{id}/messages/{mid} — 删除消息。 */
  async deleteChannelMessage(channelId: Snowflake, messageId: Snowflake): Promise<void> {
    await this.request("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  /** PUT /channels/{id}/typing — 打字指示。 */
  async sendChannelTyping(channelId: Snowflake): Promise<void> {
    await this.request("PUT", `/channels/${channelId}/typing`);
  }

  /** PUT /channels/{id}/messages/{mid}/reactions/{emoji}/@me — 添加 reaction（ack/status）。 */
  async createChannelReaction(channelId: Snowflake, messageId: Snowflake, emoji: string): Promise<void> {
    await this.request("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  /** DELETE /channels/{id}/messages/{mid}/reactions/{emoji}/@me — 移除 reaction。 */
  async deleteChannelReaction(channelId: Snowflake, messageId: Snowflake, emoji: string): Promise<void> {
    await this.request("DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  // ---- 原生命令（笔记 20：openclaw provider.deploy.ts + native-command-reply.ts 语义）----

  /** PUT /applications/{id}/commands — 全量注册/覆盖 slash 命令（reconcile）。 */
  async registerApplicationCommands(
    applicationId: Snowflake,
    commands: Array<{ name: string; description: string; options?: unknown[] }>,
  ): Promise<DiscordApplicationCommand[]> {
    return this.request<DiscordApplicationCommand[]>("PUT", `/applications/${applicationId}/commands`, commands);
  }

  /** GET /applications/{id}/commands — 现有全局命令（注册去重对比）。 */
  async listApplicationCommands(applicationId: Snowflake): Promise<DiscordApplicationCommand[]> {
    return this.request<DiscordApplicationCommand[]>("GET", `/applications/${applicationId}/commands`);
  }

  /** GET /applications/{id}/guilds/{gid}/commands — 现有 guild 命令（注册去重对比）。 */
  async listGuildApplicationCommands(
    applicationId: Snowflake,
    guildId: Snowflake,
  ): Promise<DiscordApplicationCommand[]> {
    return this.request<DiscordApplicationCommand[]>(
      "GET",
      `/applications/${applicationId}/guilds/${guildId}/commands`,
    );
  }
  /**
   * PUT /applications/{id}/guilds/{gid}/commands — guild 级注册（笔记 25 续：
   * skills 走 guild 额度，全局 100 上限之外独立 100/guild，绕过全局超限）。
   */
  async registerGuildApplicationCommands(
    applicationId: Snowflake,
    guildId: Snowflake,
    commands: Array<{ name: string; description: string; options?: unknown[] }>,
  ): Promise<DiscordApplicationCommand[]> {
    return this.request<DiscordApplicationCommand[]>(
      "PUT",
      `/applications/${applicationId}/guilds/${guildId}/commands`,
      commands,
    );
  }

  /** GET /users/@me/guilds — bot 所在服务器列表（guild 命令注册目标）。 */
  async listMyGuilds(): Promise<DiscordGuildSummary[]> {
    return this.request<DiscordGuildSummary[]>("GET", "/users/@me/guilds");
  }

  /** POST /interactions/{id}/{token}/callback — interaction 首次响应（204 无 body）。 */
  async createInteractionResponse(
    interactionId: Snowflake,
    token: string,
    payload: { type: number; data?: Record<string, unknown> },
  ): Promise<void> {
    await this.request("POST", `/interactions/${interactionId}/${token}/callback`, payload);
  }

  /** POST /webhooks/{applicationId}/{token} — interaction followUp（defer 后必须 followUp）。 */
  async createInteractionFollowUp(
    applicationId: Snowflake,
    token: string,
    payload: { content: string; flags?: number },
  ): Promise<DiscordCreatedMessage> {
    return this.request<DiscordCreatedMessage>(
      "POST",
      `/webhooks/${applicationId}/${token}`,
      payload,
    );
  }

  /** DELETE /webhooks/{applicationId}/{token}/messages/@original — 删除原始响应。 */
  async deleteInteractionOriginalResponse(applicationId: Snowflake, token: string): Promise<void> {
    await this.request("DELETE", `/webhooks/${applicationId}/${token}/messages/@original`);
  }
}
