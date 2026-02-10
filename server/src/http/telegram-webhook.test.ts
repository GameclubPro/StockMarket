import assert from 'node:assert/strict';
import test from 'node:test';
import { handleBotWebhookUpdate, type TelegramUpdate } from '../telegram-webhook.js';

const createDeps = () => ({
  upsertUser: async () => ({ id: 'user_1' }),
  upsertGroup: async () => {},
});

test('private command is normalized and forwarded to handler', async () => {
  let commandPayload: {
    command: string;
    args: string[];
    text: string;
  } | null = null;

  const update: TelegramUpdate = {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: 123, type: 'private' },
      from: { id: 42, username: 'AdminUser' },
      text: '/ADMIN@MyBot one two',
    },
  };

  const result = await handleBotWebhookUpdate(update, {
    ...createDeps(),
    handlePrivateMessage: async ({ command, args, text }) => {
      commandPayload = { command, args, text };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(commandPayload, {
    command: '/admin',
    args: ['one', 'two'],
    text: '/ADMIN@MyBot one two',
  });
});

test('/start payload is still forwarded', async () => {
  let startParam = '';

  const update: TelegramUpdate = {
    update_id: 2,
    message: {
      message_id: 11,
      chat: { id: 555, type: 'private' },
      from: { id: 99, username: 'RefUser' },
      text: '/start ABC123',
    },
  };

  const result = await handleBotWebhookUpdate(update, {
    ...createDeps(),
    handleStartPayload: async ({ startParam: value }) => {
      startParam = value;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(startParam, 'ABC123');
});
