import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchVkAdminGroups, resolveVkGroupId, resolveVkGroupRefFromLink, resolveVkUserIdByToken } from '../vk-api.js';

test('resolveVkGroupRefFromLink supports vk community links and wall links', () => {
  assert.equal(resolveVkGroupRefFromLink('https://vk.com/public12345'), '-12345');
  assert.equal(resolveVkGroupRefFromLink('https://vk.com/club987'), '-987');
  assert.equal(resolveVkGroupRefFromLink('https://vk.com/event42'), '-42');
  assert.equal(resolveVkGroupRefFromLink('https://vk.com/wall-555_777'), '-555');
  assert.equal(resolveVkGroupRefFromLink('https://vk.com/id99'), '99');
  assert.equal(resolveVkGroupRefFromLink('https://vk.com/my_project'), 'my_project');
  assert.equal(resolveVkGroupRefFromLink('public12345'), '-12345');
  assert.equal(resolveVkGroupRefFromLink('club987'), '-987');
  assert.equal(resolveVkGroupRefFromLink('wall-555_777'), '-555');
  assert.equal(resolveVkGroupRefFromLink('my_project'), 'my_project');
});

test('resolveVkGroupRefFromLink rejects non-vk links', () => {
  assert.equal(resolveVkGroupRefFromLink('https://example.com/public1'), null);
  assert.equal(resolveVkGroupRefFromLink(''), null);
});

test('resolveVkGroupId returns absolute numeric id for direct ids', async () => {
  assert.equal(await resolveVkGroupId('-123'), 123);
  assert.equal(await resolveVkGroupId('456'), 456);
  assert.equal(await resolveVkGroupId('0'), null);
});

test('resolveVkUserIdByToken resolves vk user id from users.get', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string) => {
    const target = String(url);
    assert.match(target, /users\.get/);
    return new Response(JSON.stringify({ response: [{ id: 777 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const userId = await resolveVkUserIdByToken('user-token');
    assert.equal(userId, 777);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchVkAdminGroups normalizes and deduplicates groups', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string) => {
    const target = String(url);
    assert.match(target, /groups\.get/);
    return new Response(
      JSON.stringify({
        response: {
          count: 2,
          items: [
            { id: 15, name: 'Alpha', screen_name: 'alpha_team' },
            { id: 15, name: 'Alpha', screen_name: 'alpha_team' },
            { id: 42, name: 'Beta' },
          ],
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  }) as typeof fetch;

  try {
    const groups = await fetchVkAdminGroups('user-token');
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.groupId, 15);
    assert.equal(groups[0]?.canonicalInviteLink, 'https://vk.com/public15');
    assert.equal(groups[1]?.groupId, 42);
    assert.equal(groups[1]?.canonicalInviteLink, 'https://vk.com/public42');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveVkUserIdByToken maps invalid user token', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        error: {
          error_code: 5,
          error_msg: 'User authorization failed',
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  }) as typeof fetch;

  try {
    await assert.rejects(() => resolveVkUserIdByToken('bad-token'), /vk_user_token_invalid/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchVkAdminGroups maps invalid user token', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        error: {
          error_code: 5,
          error_msg: 'User authorization failed',
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  }) as typeof fetch;

  try {
    await assert.rejects(() => fetchVkAdminGroups('bad-token'), /vk_user_token_invalid/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
