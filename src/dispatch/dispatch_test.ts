import { assertEquals } from "jsr:@std/assert";
import { OpenclawBridge, type OpenclawBridgeConfig } from "./dispatch.ts";

function createTestBridge(config: Partial<OpenclawBridgeConfig> = {}) {
  const sentMessages: string[] = [];
  const delivery = {
    sendMessage: async (text: string) => { sentMessages.push(text); return "msg-id"; },
    editMessage: async () => {},
    deleteMessage: async () => {},
    sendChatAction: async () => {},
  };
  const bridge = new OpenclawBridge({
    delivery,
    config: {
      streamMode: "progress",
      throttleMs: 10,
      chunkSize: 10,
      reasoningEnabled: true,
      toolProgressEnabled: true,
      debounceMs: 0,
      ...config,
    },
  });
  return { bridge, sentMessages };
}

Deno.test("连续工具超时超过阈值应 abort turn", async () => {
  const { bridge, sentMessages } = createTestBridge({ maxToolTimeouts: 3 });
  bridge.beginTurn({ chatId: "test" });

  bridge.handleActivity({ type: "tool-timeout", name: "sleep" });
  bridge.handleActivity({ type: "tool-timeout", name: "sleep" });
  bridge.handleActivity({ type: "tool-timeout", name: "sleep" });

  // 等待异步 abort 完成
  await new Promise((r) => setTimeout(r, 10));

  assertEquals(sentMessages.length, 1);
  assertEquals(sentMessages[0].includes("连续超时"), true);
  assertEquals(bridge.currentTurn(), undefined);
});

Deno.test("未达阈值不 abort", async () => {
  const { bridge, sentMessages } = createTestBridge({ maxToolTimeouts: 3 });
  bridge.beginTurn({ chatId: "test" });

  bridge.handleActivity({ type: "tool-timeout", name: "sleep" });
  bridge.handleActivity({ type: "tool-timeout", name: "sleep" });

  await new Promise((r) => setTimeout(r, 10));

  assertEquals(sentMessages.length, 0);
  assertEquals(bridge.currentTurn() !== undefined, true);
});
