import { strict as assert } from "node:assert";
import { describe, it, before, after } from "node:test";
import { loadDiscordConnectionConfig } from "../src/config.ts";

describe("loadDiscordConnectionConfig", () => {
  const originalEnv = process.env.DISCORD_BOT_TOKEN;

  before(() => {
    // Ensure environment variable is not set for these tests
    delete process.env.DISCORD_BOT_TOKEN;
  });

  after(() => {
    // Restore original environment variable
    if (originalEnv) {
      process.env.DISCORD_BOT_TOKEN = originalEnv;
    }
  });

  it("should throw an error if no Discord bot token is found", () => {
    assert.throws(
      () => loadDiscordConnectionConfig(),
      /Discord bot token not found/, // Expecting an error with this message
      "Should throw an error when no token is configured"
    );
  });

  // TODO: Add more tests for valid token scenarios, reading from discord.json, etc.
});
