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

/** Bot 所在服务器（GET /users/@me/guilds 最小面）。 */
export interface DiscordGuildSummary {
  id: Snowflake;
  name?: string;
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

export type GatewayDispatchName = "READY" | "RESUMED" | "MESSAGE_CREATE" | "MESSAGE_UPDATE" | "INTERACTION_CREATE";

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
  /** bot 应用信息（slash 命令注册需要 application.id）。 */
  application?: { id?: Snowflake };
  /** bot 用户（/cmd@bot mention 剥离需要 username）。 */
  user?: DiscordUser;
}

/** 网关事件回调（按需订阅的 dispatch）。 */
export interface GatewayEventMap {
  ready: (data: GatewayReadyData) => void;
  messageCreate: (message: DiscordMessage) => void;
  messageUpdate: (message: DiscordMessage) => void;
  /** 连接已关闭且无法恢复（fatal）。 */
  fatal: (code: number) => void;
  /** slash 命令交互（INTERACTION_CREATE）。 */
  interactionCreate: (interaction: DiscordInteraction) => void;
}

// ---- Application Commands & Interactions（discord-api-types v10 最小面，笔记 20）----

/** Discord interaction type（InteractionType 子集）。 */
export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ApplicationCommandAutocomplete: 4,
  ModalSubmit: 5,
} as const;

/** Interaction callback type（InteractionResponseType 子集）。 */
export const InteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
  DeferredUpdateMessage: 6,
  UpdateMessage: 7,
  AutocompleteResult: 8,
  Modal: 9,
} as const;

/** Interaction response flags（仅 ephemeral 需要）。 */
export const MessageFlags = {
  Ephemeral: 1 << 6,
} as const;

/** 已部署的 application command（REST 注册响应）。 */
export interface DiscordApplicationCommand {
  id?: Snowflake;
  name: string;
  description?: string;
  options?: Array<{
    name: string;
    description: string;
    type: number;
    required?: boolean;
    choices?: Array<{ name: string; value: string | number | boolean }>;
  }>;
}

/** INTERACTION_CREATE 载荷最小面。 */
export interface DiscordInteraction {
  id: Snowflake;
  type: number;
  token: string;
  application_id?: Snowflake;
  channel_id?: Snowflake;
  guild_id?: Snowflake;
  user?: DiscordUser;
  member?: { roles?: string[] };
  /** application command 数据（type=2 时）。 */
  data?: {
    id?: Snowflake;
    name: string;
    /** type=1 子命令的嵌套 options（/skill github 场景）。 */
    options?: Array<{
      name: string;
      type: number;
      value?: string | number | boolean;
      options?: Array<{
        name: string;
        type: number;
        value?: string | number | boolean;
      }>;
    }>;
  };
}
