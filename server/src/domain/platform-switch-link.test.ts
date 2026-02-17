import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTelegramSwitchUrl,
  buildVkSwitchUrl,
  resolvePlatformSwitchSourceUser,
  resolvePlatformLinkCode,
} from './platform-switch-link.js';

const parseHash = (hashValue: string) => {
  const normalized = hashValue.replace(/^#/, '');
  if (!normalized) return { path: '', params: new URLSearchParams() };

  const queryIndex = normalized.indexOf('?');
  if (queryIndex >= 0) {
    const path = normalized.slice(0, queryIndex);
    const query = normalized.slice(queryIndex + 1);
    return { path, params: new URLSearchParams(query) };
  }

  if (normalized.includes('=') || normalized.includes('&')) {
    return { path: '', params: new URLSearchParams(normalized) };
  }

  return { path: normalized, params: new URLSearchParams() };
};

test('buildTelegramSwitchUrl adds startapp and fallback link params', () => {
  const code = 'LINK_A1B2C3D4';
  const result = buildTelegramSwitchUrl(
    code,
    'https://t.me/JoinRush_bot?startapp=home&foo=1'
  );
  const parsed = new URL(result);

  assert.equal(parsed.searchParams.get('startapp'), `link_${code}`);
  assert.equal(parsed.searchParams.get('link_code'), code);
  assert.equal(parsed.searchParams.get('jr_link_code'), code);
  assert.equal(parsed.searchParams.get('foo'), '1');
});

test('buildTelegramSwitchUrl falls back for non-http(s) mini app url', () => {
  const code = 'LINK_QA1WS2ED';
  const result = buildTelegramSwitchUrl(code, 'tg://resolve?domain=JoinRush_bot');
  const parsed = new URL(result);

  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.hostname, 't.me');
  assert.equal(parsed.searchParams.get('startapp'), `link_${code}`);
  assert.equal(parsed.searchParams.get('link_code'), code);
  assert.equal(parsed.searchParams.get('jr_link_code'), code);
});

test('buildVkSwitchUrl adds vk_ref and fallback link params', () => {
  const code = 'LINK_9Z8Y7X6W';
  const result = buildVkSwitchUrl(code, 'https://vk.com/app54453849?foo=1');
  const parsed = new URL(result);

  assert.equal(parsed.searchParams.get('vk_ref'), `link_${code}`);
  assert.equal(parsed.searchParams.get('link_code'), code);
  assert.equal(parsed.searchParams.get('jr_link_code'), code);
  assert.equal(parsed.searchParams.get('foo'), '1');
});

test('buildVkSwitchUrl preserves hash path and existing hash query', () => {
  const code = 'LINK_Q1W2E3R4';
  const result = buildVkSwitchUrl(code, 'https://vk.com/app54453849#/promo?tab=tasks');
  const parsed = new URL(result);
  const hash = parseHash(parsed.hash);

  assert.equal(hash.path, '/promo');
  assert.equal(hash.params.get('tab'), 'tasks');
  assert.equal(hash.params.get('vk_ref'), `link_${code}`);
  assert.equal(hash.params.get('link_code'), code);
  assert.equal(hash.params.get('jr_link_code'), code);
});

test('resolvePlatformLinkCode prioritizes valid body link code', () => {
  const resolved = resolvePlatformLinkCode({
    bodyLinkCode: 'link_a1b2c3d4',
    startParam: 'link_LINK_Z9Y8X7W6',
  });

  assert.equal(resolved.linkCode, 'LINK_A1B2C3D4');
  assert.equal(resolved.hasBodyLinkCode, true);
  assert.equal(resolved.hasStartParamLinkCode, true);
  assert.equal(resolved.bodyCodeInvalid, false);
});

test('resolvePlatformLinkCode uses start param with link_ prefix', () => {
  const resolved = resolvePlatformLinkCode({
    startParam: 'link_LINK_M1N2B3V4',
  });

  assert.equal(resolved.linkCode, 'LINK_M1N2B3V4');
  assert.equal(resolved.hasBodyLinkCode, false);
  assert.equal(resolved.hasStartParamLinkCode, true);
  assert.equal(resolved.bodyCodeInvalid, false);
});

test('resolvePlatformLinkCode supports direct LINK_ start param (vk_ref)', () => {
  const resolved = resolvePlatformLinkCode({
    startParam: 'LINK_H1J2K3L4',
  });

  assert.equal(resolved.linkCode, 'LINK_H1J2K3L4');
  assert.equal(resolved.hasStartParamLinkCode, true);
});

test('resolvePlatformLinkCode flags invalid body code and rejects invalid start code', () => {
  const resolved = resolvePlatformLinkCode({
    bodyLinkCode: 'broken',
    startParam: 'link_broken',
  });

  assert.equal(resolved.linkCode, '');
  assert.equal(resolved.hasBodyLinkCode, true);
  assert.equal(resolved.hasStartParamLinkCode, false);
  assert.equal(resolved.bodyCodeInvalid, true);
});

test('resolvePlatformSwitchSourceUser keeps token user when identity is empty or equal', () => {
  assert.deepEqual(
    resolvePlatformSwitchSourceUser({
      tokenUserId: 'user_token',
      identityUserId: '',
    }),
    {
      sourceUserId: 'user_token',
      mismatch: false,
    }
  );

  assert.deepEqual(
    resolvePlatformSwitchSourceUser({
      tokenUserId: 'user_token',
      identityUserId: 'user_token',
    }),
    {
      sourceUserId: 'user_token',
      mismatch: false,
    }
  );
});

test('resolvePlatformSwitchSourceUser uses identity user on mismatch', () => {
  assert.deepEqual(
    resolvePlatformSwitchSourceUser({
      tokenUserId: 'user_from_token',
      identityUserId: 'user_from_identity',
    }),
    {
      sourceUserId: 'user_from_identity',
      mismatch: true,
    }
  );
});
