// Discord transport minimal types — ported from openclaw extensions/discord (笔记 10).
// 只保留本项目需要的最小面（snowflake ID、消息、Gateway 事件）。

/** Discord snowflake ID（字符串）。 */
export type Snowflake = string;

export interface DiscordUser {
  id: Snowflake;
  username: string;
  bot?: boolean;
}

export interface DiscordMessage {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id?: Snowflake;
  content: string;
  author?: DiscordUser;
  /** 提及的用户 id（MESSAGE_CREATE 时由 gateway 填充 mentions）。 */
  mentions?: Array<{ id: Snowflake; bot?: boolean }>;
  /** 回复引用的消息。 */
  message_reference?: { message_id?: Snowflake; channel_id?: Snowflake; guild_id?: Snowflake };
  member?: { roles?: string[] };
}

/** REST 发送响应最小面（只需要 message id）。 */
export interface DiscordCreatedMessage {
  id?: Snowflake;
}

// ---- Gateway ----

/** Gateway opcode（discord-api-types GatewayOpcodes 子集）。 */
export const GatewayOpcode = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  PresenceUpdate: 3,
  VoiceStateUpdate: 4,
  Resume: 6,
  Reconnect: 7,
  RequestGuildMembers: 8,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

export type GatewayDispatchName = "READY" | "RESUMED" | "MESSAGE_CREATE" | "MESSAGE_UPDATE";

export interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string;
}

export interface GatewayHelloData {
  heartbeat_interval: number;
}

export interface GatewayReadyData {
  session_id: string;
  resume_gateway_url?: string;
}

/** 网关事件回调（按需订阅的 dispatch）。 */
export interface GatewayEventMap {
  ready: (data: GatewayReadyData) => void;
  messageCreate: (message: DiscordMessage) => void;
  messageUpdate: (message: DiscordMessage) => void;
  /** 连接已关闭且无法恢复（fatal）。 */
  fatal: (code: number) => void;
}
