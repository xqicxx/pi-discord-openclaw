// Discord Gateway client — ported from openclaw extensions/discord src/internal/gateway.ts (笔记 10).
// 零依赖：node 22 原生 WebSocket。核心：identify / heartbeat / resume / 断线重连。
import type {
  GatewayHelloData,
  GatewayPayload,
  GatewayReadyData,
  GatewayDispatchName,
  DiscordMessage,
  DiscordInteraction,
} from "./types.ts";

const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/";
const MAX_RECONNECT_ATTEMPTS = 50;

/** fatal 关闭码：不能重连（认证/分片/API 版本/权限问题）。 */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4003, 4013, 4014]);
/** 不可 resume 的关闭码：需要全新 identify。 */
const NON_RESUMABLE_CLOSE_CODES = new Set([4000, 4007, 4008, 4009]);

const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export interface DiscordGatewayOptions {
  token: string;
  intents?: number;
  /** 自定义 ws 构造（测试注入）。 */
  createSocket?: (url: string) => WebSocket;
}

export interface DiscordGatewayEvents {
  ready: (data: GatewayReadyData) => void;
  messageCreate: (message: DiscordMessage) => void;
  messageUpdate: (message: DiscordMessage) => void;
  interactionCreate: (interaction: DiscordInteraction) => void;
  fatal: (code: number) => void;
  error: (error: Error) => void;
}

type AnyFn = (payload: unknown) => void;

/** 最小事件分发器（零依赖，避免 node:events 类型负担）。 */
class Emitter {
  private readonly listeners = new Map<string, Set<AnyFn>>();

  on<K extends keyof DiscordGatewayEvents>(event: K, fn: DiscordGatewayEvents[K]): void {
    const list = this.listeners.get(event) ?? new Set();
    list.add(fn as AnyFn);
    this.listeners.set(event, list);
  }

  emit<K extends keyof DiscordGatewayEvents>(event: K, payload: Parameters<DiscordGatewayEvents[K]>[0]): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        (fn as (p: unknown) => void)(payload);
      } catch (error) {
        console.error("[pi-discord-openclaw] gateway listener error:", error);
      }
    }
  }
}

export class DiscordGateway {
  readonly events = new Emitter();
  private readonly token: string;
  private readonly intents: number;
  private readonly createSocket: (url: string) => WebSocket;
  private ws: WebSocket | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  private heartbeatAcked = true;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private connected = false;
  private pendingReconnect: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DiscordGatewayOptions) {
    this.token = options.token;
    this.intents = options.intents ?? 0;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
  }

  /** 连接（可选 resume 恢复）。 */
  connect(resume = false): void {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.shouldReconnect = true;
    const previous = this.ws;
    this.ws = null;
    if (previous) {
      // 先置 null：旧 socket 的 close 回调不再触发重连竞争
      previous.close(1000, "reconnecting");
    }
    const baseUrl = resume && this.resumeGatewayUrl ? this.resumeGatewayUrl : DEFAULT_GATEWAY_URL;
    const url = new URL(baseUrl);
    url.searchParams.set("v", url.searchParams.get("v") ?? "10");
    url.searchParams.set("encoding", url.searchParams.get("encoding") ?? "json");
    this.ws = this.createSocket(url.toString());
    this.setupSocket(resume);
  }

  /** 主动断开（不再重连）。 */
  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.ws?.close(1000, "client disconnect");
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private setupSocket(resume: boolean): void {
    const socket = this.ws;
    if (!socket) return;
    socket.addEventListener("open", () => {
      if (socket !== this.ws) return;
      // 真正的 ready 在 READY dispatch 时发出（open 只是 TCP/WS 建立）
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.ws) return;
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(String(event.data)) as GatewayPayload;
      } catch {
        this.events.emit("error", new Error("invalid gateway payload"));
        return;
      }
      this.handlePayload(payload, resume);
    });
    socket.addEventListener("close", (event) => {
      if (socket !== this.ws) return;
      this.handleClose(event.code);
    });
    socket.addEventListener("error", () => {
      if (socket !== this.ws) return;
      this.events.emit("error", new Error("gateway websocket error"));
    });
  }

  private handlePayload(payload: GatewayPayload, resume: boolean): void {
    if (payload.s !== null && payload.s !== undefined) {
      this.sequence = payload.s;
    }
    switch (payload.op) {
      case OP_HELLO: {
        const hello = payload.d as GatewayHelloData;
        this.startHeartbeat(hello.heartbeat_interval ?? 45_000);
        if (resume && this.sessionId) {
          this.send({ op: OP_RESUME, d: { token: this.token, session_id: this.sessionId, seq: this.sequence } });
        } else {
          this.send({
            op: OP_IDENTIFY,
            d: {
              token: this.token,
              intents: this.intents,
              properties: { os: process.platform, browser: "pi-discord-openclaw", device: "pi-discord-openclaw" },
            },
          });
        }
        break;
      }
      case OP_HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;
      case OP_HEARTBEAT:
        this.sendHeartbeat();
        break;
      case OP_RECONNECT:
        this.scheduleReconnect({ preferResume: true, minDelayMs: 0 });
        break;
      case OP_INVALID_SESSION: {
        if (!payload.d) this.sessionId = null;
        this.scheduleReconnect({
          preferResume: Boolean(payload.d),
          minDelayMs: 1_000 + Math.floor(Math.random() * 4_000),
        });
        break;
      }
      case 0 /* Dispatch */:
        this.handleDispatch(payload);
        break;
    }
  }

  private handleDispatch(payload: GatewayPayload): void {
    const type = payload.t as GatewayDispatchName | undefined;
    if (type === "READY") {
      const ready = payload.d as GatewayReadyData;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? null;
      this.reconnectAttempts = 0;
      this.connected = true;
      this.events.emit("ready", ready);
      return;
    }
    if (type === "RESUMED") {
      this.reconnectAttempts = 0;
      this.connected = true;
      return;
    }
    if (type === "MESSAGE_CREATE") {
      this.events.emit("messageCreate", payload.d as DiscordMessage);
    } else if (type === "MESSAGE_UPDATE") {
      this.events.emit("messageUpdate", payload.d as DiscordMessage);
    } else if (type === "INTERACTION_CREATE") {
      this.events.emit("interactionCreate", payload.d as DiscordInteraction);
    }
  }

  private handleClose(code: number): void {
    this.stopHeartbeat();
    this.connected = false;
    if (!this.shouldReconnect) return;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.shouldReconnect = false;
      this.events.emit("fatal", code);
      return;
    }
    if (NON_RESUMABLE_CLOSE_CODES.has(code)) {
      this.sessionId = null;
    }
    this.scheduleReconnect({ preferResume: !NON_RESUMABLE_CLOSE_CODES.has(code), minDelayMs: 0 });
  }

  private scheduleReconnect(options: { preferResume: boolean; minDelayMs: number }): void {
    this.shouldReconnect = true;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.events.emit("fatal", -1);
      return;
    }
    this.reconnectAttempts += 1;
    // 指数退避：1s → 2s → 4s … 上限 30s
    const backoff = Math.min(30_000, 1_000 * 2 ** (this.reconnectAttempts - 1));
    const delay = Math.max(options.minDelayMs, backoff);
    this.clearReconnectTimer();
    this.pendingReconnect = setTimeout(() => {
      this.pendingReconnect = undefined;
      this.connect(options.preferResume);
    }, delay);
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatAcked = true;
    this.heartbeatInterval = setInterval(() => {
      if (!this.heartbeatAcked) {
        // 心跳超时（zombie）→ 重连
        this.scheduleReconnect({ preferResume: true, minDelayMs: 0 });
        return;
      }
      this.sendHeartbeat();
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private clearReconnectTimer(): void {
    if (this.pendingReconnect) {
      clearTimeout(this.pendingReconnect);
      this.pendingReconnect = undefined;
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.heartbeatAcked = false;
    this.send({ op: OP_HEARTBEAT, d: this.sequence });
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Discord gateway socket is not open");
    }
    this.ws.send(JSON.stringify(payload));
  }
}
