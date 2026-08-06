# pi-discord-openclaw

<p align="center">
  <strong>Recreate the OpenClaw streaming experience for the <a href="https://github.com/xqicxx/pi">Pi coding agent</a> on Discord.</strong><br/>
  🧠 Separate italic reasoning · 🔧 Live tool progress · 📝 Typewriter-style streamed answers · ⏭️ Debounced follow-ups · ⏳→👀→🧠→✓ Status emoji state machine
</p>

<p align="center">
  <b>English</b> |
  <a href="READMEs/README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white" />
  <img alt="License" src="https://img.shields.io/github/license/xqicxx/pi-discord-openclaw?color=blue" />
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-0-2ea44f" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-18%20files%20green-2ea44f" />
  <img alt="Pi" src="https://img.shields.io/badge/pi-extension-8A2BE2" />
</p>

<p align="center">
  <a href="#why">Why</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#configuration">Configuration</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#commands">Commands</a> &bull;
  <a href="#how-it-works">How It Works</a> &bull;
  <a href="#tests">Tests</a> &bull;
  <a href="#docs">Docs</a> &bull;
  <a href="#safety">Safety</a>
</p>

---

## Why?

OpenClaw's Discord channel is the **gold standard for streaming output**: reasoning, tool calls, and answers flow through one channel with clear visual hierarchy. This project brings that exact experience to Pi:

| Dimension | Typical bot | OpenClaw style (this project) |
|---|---|---|
| 🧠 Reasoning | Invisible / mixed into the reply | Its own italic message (🧠 prefix), separate from the answer |
| 🔧 Tool progress | Visible only after it finishes | Live per-line updates (`**🔧 name** `detail` *running*`), corrected incrementally by id |
| 📝 Answer | Sent all at once | The same message keeps being edited, streaming out chunk by chunk |
| ⏭️ Follow-ups | Interrupt each other | Debounced and batched, without breaking the current turn |
| ⏹️ New message | Waits in an endless queue | Interrupts the current task and replies first (run-now) |
| 📊 Wrap-up | Progress box lingers forever | Collapses into a single small gray summary line when the answer lands |

## Features

- **🧠 Reasoning lane** — `<think>` extraction + `🧠 _italic_` rendering, multi-block thought state machine (ported from openclaw's reasoning-lane)
- **🔧 Tool progress** — tool-start/update/end three-state lines, `✓ 🛠️ bash: ...` / `✗ 🧩 fabric_exec`, incremental updates by id, capped line count
- **📝 Typewriter answers** — 2000-char chunking, throttled edits, retry on failure, preview message (draft-stream)
- **⏭️ Follow-up merging** — dual-lane debounce, message coalescing, serial flush
- **⏳→👀→🧠→✓ Status emoji** — queueing (⏳), processing (👀), thinking (🧠), tools (🛠️), done (✓); single-channel state machine, only ever moves forward, and the **✓ completion state stays put** (openclaw `removeAckAfterReply=false` parity — no fallback to ⏳, no cleanup); new messages during a turn are **queued** (openclaw steer/followup semantics) instead of interrupting
- **📊 Collapse summary** — on answer delivery the box folds into `-# 🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns` (openclaw's core mechanism)
- **🪄 Markdown tables → Discord embeds** — `tableMode: embed` renders tables as real Discord embed cards
- **⌨️ Command system** — 88+ global commands + 55 `/skill` subcommands (grouped by category, guild-scoped registration), executed locally without hitting the model; `/todos`, `/whimsy`, `/sessions`, `/abort`, `/compact` bridged directly
- **⏸️ Abort triggers** — stop / 停止 / 暂停 / やめて / halt … 40+ multi-language trigger words and phrases (ported from openclaw `abort-primitives.ts`), plus `/stop`; an active turn is interrupted immediately with reactions cleaned up
- **🔁 Remote `/resume`** — `PI_SESSION` env + bridge restart restores any past session from Discord in ~15s (`/resume <id>`), no terminal needed; paired with read-only `/tree`, `/session`, `/copy`, `/settings`, `/export`
- **📊 Context health guard** — context usage is checked at every turn start; above 70% it reminds you to `/compact` (alias `/compress`) before the session bloats and stalls
- **👀 Status reactions** — queued/thinking/tool/done/error reactions through the whole lifecycle, with custom emoji and timing
- **🛡️ Safe by default** — channel allowlist, `ignoreBots`, token masking, per-turn watchdog timeout
- **🚀 Zero dependencies** — Node ≥ 22 native fetch + WebSocket; one extension file, plug and play

## Quick Start

### 1. Create a Discord Bot

[Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot:

- Enable the **Message Content Intent** (required to receive messages)
- Gateway intents: `Guilds | GuildMessages | DirectMessages | MessageContent`
- Invite the bot to your server

### 2. Configure `discord.json`

At `~/.pi/agent/discord.json` (or `$PI_CODING_AGENT_DIR/discord.json`):

```json
{
  "token": "DISCORD_BOT_TOKEN",
  "channels": ["channel ids (optional, empty = all)"],
  "ignoreBots": true,
  "openclawStyle": {
    "enabled": true,
    "streaming": { "mode": "progress", "throttleMs": 1200, "chunkSize": 1900, "receiptSummary": true, "maxLineChars": 60 },
    "reasoning": { "enabled": true, "style": "emoji-italic" },
    "toolProgress": { "enabled": true, "maxLines": 8 },
    "inbound": { "debounceMs": 1000 }
  }
}
```

The token can also be provided via the `DISCORD_BOT_TOKEN` environment variable.

### 3. Load as a Pi Extension

This project is a [Pi](https://github.com/xqicxx/pi) extension (`pi.extensions: ["./index.ts"]`). Put the repo in Pi's extension directory (or install it via Pi's extension mechanism) and start Pi — the bridge registers its slash commands on ready and starts listening.

### 4. Chat

Just send a message in a configured channel — watch reasoning, tool progress, and the typewriter answer flow in sequence.

## Configuration

| Field | Default | Description |
|---|---|---|
| `token` | — | Bot token (or use the `DISCORD_BOT_TOKEN` env var) |
| `channels` | `[]` | Allowed channel ids; empty = all |
| `ignoreBots` | `true` | Ignore messages from other bots |
| `streaming.mode` | `progress` | `progress` (progress box) / `partial` / `full` |
| `streaming.throttleMs` | `1200` | Edit throttling interval |
| `streaming.chunkSize` | `1900` | Chunk size (under Discord's 2000 limit) |
| `streaming.receiptSummary` | `false` | Collapse into `-# 🧠 N · 🛠️ N · ⏱️ Ns` summary on delivery |
| `streaming.maxLineChars` | `120` | Char budget for reasoning/tool lines |
| `streaming.thinking` | `true` | Inject the chain of thought into the progress box |
| `streaming.commandText` | `raw` | Command text mode `raw` / `status` |
| `reasoning.style` | `emoji-italic` | `emoji-italic` / `italic` / `hidden` |
| `toolProgress.maxLines` | `8` | Max tool progress lines |
| `inbound.debounceMs` | `1000` | Follow-up merge window |
| `statusReactions` | — | Phase reactions (queued/thinking/tool/done/error…), timing overrides |
| `turnWatchdogMs` | `90000` | Per-turn no-activity timeout |
| `tableMode` | `code` | Table rendering: `embed` / `code` / `off` |

## Architecture

```
Discord ⇄ transport (REST + Gateway) ⇄ OpenclawBridge ⇄ pi agent
                         │
                         ├─ AnswerLane     📝 streamed edits (draft-stream, 2000 chunk/throttle/retry)
                         ├─ ReasoningLane  🧠 reasoning stream (<think> extraction + 🧠 italic)
                         ├─ ProgressLane   🔧 tool progress (tool-start/update/end lines)
                         ├─ InboundDebouncer ⏭️ follow-up merging
                         └─ CommandLane    ⌨️ text /xx interception + local slash execution
```

Layered design (openclaw blueprint, research notes 09–30):

| Layer | Files | Responsibility |
|---|---|---|
| transport | `src/transport/discord-rest.ts` | REST client: Bot header, v10 API, 429 retry-after, timeouts |
| transport | `src/transport/discord-gateway.ts` | Gateway WS: identify/heartbeat/resume/reconnect |
| transport | `src/transport/types.ts` | Minimal Discord types (snowflake/message/events) |
| lanes | `src/draft/draft-stream.ts` | 2000-char chunking, throttled edits, retry, preview message |
| lanes | `src/reasoning/reasoning-lane.ts` | `<think>` extraction, 🧠 italic, thought-step state machine |
| lanes | `src/progress/progress-lane.ts` | Tool progress lines (Discord Markdown), incremental by id |
| lanes | `src/inbound/debounce.ts` | Dual-lane debounce, message merging, serial flush |
| dispatch | `src/dispatch/dispatch.ts` | TurnManager lifecycle, event routing, OpenclawBridge |
| dispatch | `src/dispatch/markdown-tables.ts` | Markdown tables → embeds / ASCII tables, fence-aware chunking |
| dispatch | `src/dispatch/discord-api-adapter.ts` | transport → bridge delivery interface |
| commands | `src/commands/` | Slash registration/dispatch, `/todos`, `/whimsy`, text-command interception |
| feedback | `src/feedback/ack-reactions.ts` | Status reactions (queued→thinking→tool→done/error) |
| security | `src/security/token-mask.ts` | Token masking |
| config | `src/config.ts` | `discord.json` loading (openclawStyle + token + channels) |

## Commands

- **88+ global commands**: `/abort`, `/compact` (+ alias `/compress`), `/resume`, `/model`, `/sessions`, `/todos`, `/whimsy`, `/quit` and more — executed locally, never routed to the model
- **55 `/skill` subcommands**: grouped by category (video 19 / dev 14 / fabric 12 / tools 10, each ≤ Discord's 25 limit), guild-scoped registration to stay under the global cap of 100
- **Text commands**: `/xx` text-prefix interception, forwarded for local execution

## How It Works

A turn's full lifecycle:

1. User sends a message → Gateway receives `MESSAGE_CREATE` → text-command interception check
2. Non-command messages enter the debounce window (`debounceMs`); consecutive inputs are merged
3. Message submitted to Pi → `queued` reaction → task starts
4. Pi produces reasoning → ReasoningLane renders `🧠 _italic_` lines; tool calls → ProgressLane updates line by line
5. Answer begins → draft-stream edits the same message chunk by chunk (typewriter effect)
6. A new message arrives → current turn is aborted, the new message is handled first (run-now)
7. Turn ends → progress box collapses into a summary line, reaction flips to `done`/`error`

## Tests

```bash
npm test          # 21 test files (transport/rest/gateway, draft, lanes, dispatch, commands, reactions, interrupt, resume, e2e-turn)
npm run typecheck # 10 pre-existing type errors (draft-stream etc., runtime-safe, on the fix list)
npm run validate  # typecheck + test + audit + pack check
```

## Docs

- `docs/openclaw-research/09-36`: research notes — transport / draft stream / chunking + Markdown / inbound / outbound + threads / Telegram→Discord mapping / command system / registration limits / reasoning-answer separation / interrupt & queue semantics / abort triggers / resume / reactions lifecycle
- `docs/architecture.md`: architecture overview
- `CHANGELOG.md`: version history
- `BACKLOG.md`: roadmap

## Safety

- Only configured channels are handled; `ignoreBots` ignores other bots by default
- No terminal control; only message streaming and replies (same philosophy as OpenClaw)
- 2000-char hard cap: long text is chunked (1900 default), fence-aware chunking never splits code blocks
- Tokens are always masked; a per-turn watchdog kills zombie tasks

## License

MIT — forked from [pi-telegram-openclaw](https://github.com/xqicxx/pi-telegram-openclaw) with the transport swapped to Discord while keeping the OpenClaw streaming pipeline intact.

## 测试条目（验证 Code Assist 审核闭环，观察后关闭）
