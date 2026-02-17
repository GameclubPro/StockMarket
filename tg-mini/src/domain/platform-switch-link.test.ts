import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTelegramDeepLinkFromHttpUrl } from './platform-switch-link.ts';

test('buildTelegramDeepLinkFromHttpUrl converts t.me url to tg deep link', () => {
  const result = buildTelegramDeepLinkFromHttpUrl('https://t.me/JoinRush_bot?startapp=link_LINK_X1Y2Z3Q4');
  assert.equal(
    result,
    'tg://resolve?domain=JoinRush_bot&startapp=link_LINK_X1Y2Z3Q4'
  );
});

test('buildTelegramDeepLinkFromHttpUrl preserves extra query params', () => {
  const result = buildTelegramDeepLinkFromHttpUrl(
    'https://t.me/JoinRush_bot?startapp=link_LINK_X1Y2Z3Q4&foo=1&bar=hello'
  );
  const parsed = new URL(result);

  assert.equal(parsed.protocol, 'tg:');
  assert.equal(parsed.hostname, 'resolve');
  assert.equal(parsed.searchParams.get('domain'), 'JoinRush_bot');
  assert.equal(parsed.searchParams.get('startapp'), 'link_LINK_X1Y2Z3Q4');
  assert.equal(parsed.searchParams.get('foo'), '1');
  assert.equal(parsed.searchParams.get('bar'), 'hello');
});

test('buildTelegramDeepLinkFromHttpUrl returns empty string for unsupported host', () => {
  const result = buildTelegramDeepLinkFromHttpUrl('https://example.com/JoinRush_bot?startapp=home');
  assert.equal(result, '');
});

test('buildTelegramDeepLinkFromHttpUrl returns empty string for non-http(s) urls', () => {
  const result = buildTelegramDeepLinkFromHttpUrl('tg://resolve?domain=JoinRush_bot');
  assert.equal(result, '');
});
