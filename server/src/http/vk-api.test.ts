import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVkGroupId, resolveVkGroupRefFromLink } from '../vk-api.js';

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
