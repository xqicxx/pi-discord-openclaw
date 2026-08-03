// pi-telegram-openclaw — OpenClaw-style Telegram streaming for pi
// Ports: draft-stream lanes, reasoning lane (🧠), tool progress (🔧), inbound debounce.
// Reference: openclaw extensions/telegram (draft-stream.ts, reasoning-lane-coordinator.ts,
//            progress-draft-preview.ts, bot-handlers.inbound-debounce.runtime.ts)

import type { ExtensionAPI } from "@earendil-works/pi-agent-core";
import { DraftStreamManager } from "./draft/draft-stream.ts";
import { ReasoningLane } from "./reasoning/reasoning-lane.ts";
import { ProgressLane } from "./progress/progress-lane.ts";
import { InboundDebouncer } from "./inbound/debounce.ts";
import { loadOpenclawStyleConfig, type OpenclawStyleConfig } from "./config.ts";

const TAG = "[pi-telegram-openclaw]";

export default function (pi: ExtensionAPI) {
  const cfg: OpenclawStyleConfig = loadOpenclawStyleConfig();
  if (!cfg.enabled) {
    console.log(`${TAG} disabled via config`);
    return;
  }

  const drafts = new DraftStreamManager(cfg.streaming);
  const reasoning = new ReasoningLane(cfg.reasoning, drafts);
  const progress = new ProgressLane(cfg.toolProgress, drafts);
  const inbound = new InboundDebouncer(cfg.inbound, pi);

  console.log(`${TAG} OpenClaw-style streaming enabled`);

  pi.hooks.onActivity((event) => {
    switch (event.type) {
      case "agent-start":
        drafts.beginTurn();
        reasoning.beginTurn();
        progress.beginTurn();
        break;
      case "reasoning-delta":
        reasoning.onDelta(event.delta);
        break;
      case "reasoning-end":
        reasoning.finalize();
        break;
      case "assistant-text-delta":
        drafts.updateAnswer(event.delta);
        break;
      case "assistant-segment":
        drafts.finalizeAnswer(event);
        break;
      case "tool-start":
        progress.onToolStart(event);
        break;
      case "tool-update":
        progress.onToolUpdate(event);
        break;
      case "tool-end":
        progress.onToolEnd(event);
        break;
      case "agent-end":
        drafts.endTurn();
        reasoning.endTurn();
        progress.endTurn();
        break;
      case "agent-settled":
        drafts.settle();
        break;
    }
  });

  // Follow-up coalescing: consecutive inbound texts merge into one turn.
  pi.registerInboundInterceptor?.((text) => {
    return inbound.push(text);
  });
}
