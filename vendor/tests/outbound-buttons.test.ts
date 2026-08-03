/**
 * Regression tests for Telegram outbound button helpers
 * Exercises assistant-authored button markup extraction, action storage, callback handling, and prompt-turn construction
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramButtonActionStore,
  createTelegramButtonPromptTurn,
  handleTelegramButtonCallbackQuery,
  planTelegramButtonReply,
} from "../lib/outbound-buttons.ts";

test("Button reply planner strips telegram_button markup and registers actions", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button: {"label":"Run","prompt":"Run the workflow."} -->',
      "",
      "Tail.",
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );

  assert.equal(plan.markdown, "Visible answer.\n\nTail.");
  assert.deepEqual(actions, [{ text: "Run", prompt: "Run the workflow." }]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [[{ text: "Run", callback_data: "btn:1" }]],
  });
});

test("Button reply planner accepts JSON and attributes with optional separators", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      '<!-- telegram_button {"label":"JSON","prompt":"Run JSON."} -->',
      '<!-- telegram_button: {"label":"Colon JSON","prompt":"Run colon JSON.","selected_style":"success"} -->',
      '<!-- telegram_button: label="Attributes" prompt="Run attributes." -->',
      '<!-- telegram_button {"value":"JSON value"} -->',
      '<!-- telegram_button: value="Attribute value" -->',
      '<!-- telegram_button {"value":"Fallback prompt","label":"Explicit label"} -->',
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );

  assert.deepEqual(actions, [
    { text: "JSON", prompt: "Run JSON." },
    {
      text: "Colon JSON",
      prompt: "Run colon JSON.",
      selectedStyle: "success",
    },
    { text: "Attributes", prompt: "Run attributes." },
    { text: "JSON value", prompt: "JSON value" },
    { text: "Attribute value", prompt: "Attribute value" },
    { text: "Explicit label", prompt: "Fallback prompt" },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [
      [{ text: "JSON", callback_data: "btn:1" }],
      [{ text: "Colon JSON", callback_data: "btn:2" }],
      [{ text: "Attributes", callback_data: "btn:3" }],
      [{ text: "JSON value", callback_data: "btn:4" }],
      [{ text: "Attribute value", callback_data: "btn:5" }],
      [{ text: "Explicit label", callback_data: "btn:6" }],
    ],
  });
});

test("Button reply planner rejects legacy payload forms", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "<!-- telegram_button: Continue -->",
      '<!-- telegram_button label=Continue prompt="Continue." -->',
      "<!-- telegram_button label='Continue' prompt='Continue.' -->",
      '<!-- telegram_button label="Continue"\nContinue.\n-->',
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );

  assert.equal(plan.markdown, "");
  assert.deepEqual(plan.replyMarkup, undefined);
  assert.deepEqual(actions, []);
});

test("Button reply planner supplies visible text and stores selected style for a button-only reply", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    '<!-- telegram_button label="Continue" prompt="Continue now." selected_style="danger" -->',
    {
      registerAction: (action) => {
        actions.push(action);
        return "tgbtn:continue";
      },
    },
  );

  assert.equal(plan.markdown, "☑️ **Choose an option:**");
  assert.deepEqual(actions, [
    { text: "Continue", prompt: "Continue now.", selectedStyle: "danger" },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [
      [{ text: "Continue", callback_data: "tgbtn:continue" }],
    ],
  });
});

test("Button action store resolves registered actions once and expires old entries", () => {
  const store = createTelegramButtonActionStore();
  const callbackData = store.register({
    text: "Run",
    prompt: "Do it.",
    selectedStyle: "primary",
  });

  assert.deepEqual(store.resolve(callbackData), {
    text: "Run",
    prompt: "Do it.",
    selectedStyle: "primary",
  });
  assert.equal(store.resolve(callbackData), undefined);
  assert.equal(store.resolve("other:callback"), undefined);

  const expiringStore = createTelegramButtonActionStore({ ttlMs: -1 });
  const expiredCallbackData = expiringStore.register({
    text: "Expired",
    prompt: "Too late.",
  });
  assert.equal(expiringStore.resolve(expiredCallbackData), undefined);
});

test("Button prompt turn preserves prompt text and queue metadata", () => {
  const turn = createTelegramButtonPromptTurn({
    chatId: 10,
    replyToMessageId: 20,
    queueOrder: 30,
    action: { text: "Run", prompt: "Run this now." },
    target: { chatId: 10, threadId: 40 },
  });

  assert.equal(turn.kind, "prompt");
  assert.equal(turn.chatId, 10);
  assert.deepEqual(turn.target, { chatId: 10, threadId: 40 });
  assert.equal(turn.replyToMessageId, 20);
  assert.equal(turn.queueLane, "priority");
  assert.deepEqual(turn.sourceMessageIds, [20]);
  assert.deepEqual(turn.content, [
    { type: "text", text: "[telegram] Run this now." },
  ]);
  assert.equal(turn.historyText, "Run this now.");
  assert.equal(turn.statusSummary, "Run");
});

test("Button callback handler enqueues owned actions, marks the selected button, and consumes expired buttons", async () => {
  const answered: string[] = [];
  const enqueued: unknown[] = [];
  const edited: unknown[] = [];
  const handled = await handleTelegramButtonCallbackQuery(
    {
      id: "q1",
      data: "tgbtn:live",
      message: {
        message_id: 2,
        chat: { id: 1 },
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🚀 Run", callback_data: "tgbtn:live" },
              { text: "Wait", callback_data: "tgbtn:wait" },
            ],
          ],
        },
      },
    },
    "ctx",
    {
      resolveAction: () => ({
        text: "Run",
        prompt: "Run it.",
        selectedStyle: "danger",
      }),
      answerCallbackQuery: async (_id, text) => {
        answered.push(text ?? "");
      },
      enqueueButtonPrompt: (query, action, ctx) => {
        enqueued.push({ query, action, ctx });
      },
      editMessageReplyMarkup: async (chatId, messageId, replyMarkup) => {
        edited.push({ chatId, messageId, replyMarkup });
      },
    },
  );

  assert.equal(handled, true);
  assert.deepEqual(answered, ["Queued."]);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(edited, [
    {
      chatId: 1,
      messageId: 2,
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "🚀 Run",
              callback_data: "tgbtn:live",
              style: "danger",
            },
            { text: "Wait", callback_data: "tgbtn:wait" },
          ],
        ],
      },
    },
  ]);

  const expired = await handleTelegramButtonCallbackQuery(
    { id: "q2", data: "tgbtn:expired" },
    "ctx",
    {
      resolveAction: () => undefined,
      answerCallbackQuery: async (_id, text) => {
        answered.push(text ?? "");
      },
      enqueueButtonPrompt: () => {
        throw new Error("must not enqueue expired buttons");
      },
    },
  );

  assert.equal(expired, true);
  assert.deepEqual(answered, ["Queued.", "Button action expired."]);

  const duplicate = await handleTelegramButtonCallbackQuery(
    {
      id: "q3",
      data: "tgbtn:duplicate",
      message: {
        message_id: 3,
        chat: { id: 1 },
        reply_markup: {
          inline_keyboard: [
            [{ text: "Run", callback_data: "tgbtn:duplicate" }],
          ],
        },
      },
    },
    "ctx",
    {
      resolveAction: () => ({ text: "Run", prompt: "Run it." }),
      answerCallbackQuery: async (_id, text) => {
        answered.push(text ?? "");
      },
      enqueueButtonPrompt: () => false,
      editMessageReplyMarkup: async () => {
        throw new Error("must not mark a prompt that was not queued");
      },
    },
  );
  assert.equal(duplicate, true);
  assert.deepEqual(answered, [
    "Queued.",
    "Button action expired.",
    "Already queued.",
  ]);
});
