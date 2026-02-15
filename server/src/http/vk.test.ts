import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  extractVkLaunchParams,
  isVkLaunchParamsPayload,
  verifyVkLaunchParams,
} from '../vk.js';

const toBase64Url = (value: string) =>
  value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const buildSignedData = (params: URLSearchParams) =>
  [...params.entries()]
    .filter(([key]) => key.startsWith('vk_'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

const createSign = (params: URLSearchParams, secret: string) =>
  toBase64Url(crypto.createHmac('sha256', secret).update(buildSignedData(params)).digest('base64'));

test('verifyVkLaunchParams validates signed payload', () => {
  const secret = 'vk_secret_123';
  const params = new URLSearchParams({
    vk_access_token_settings: 'friends',
    vk_app_id: '123456',
    vk_platform: 'mobile_android',
    vk_ref: 'ABC123',
    vk_user_id: '777',
  });
  params.set('sign', createSign(params, secret));

  const payload = verifyVkLaunchParams(params.toString(), secret, 86_400);
  assert.equal(payload.vk_user_id, '777');
  assert.equal(payload.vk_platform, 'mobile_android');
  assert.equal(payload.vk_ref, 'ABC123');
});

test('verifyVkLaunchParams rejects tampered sign', () => {
  const secret = 'vk_secret_123';
  const params = new URLSearchParams({
    vk_app_id: '123456',
    vk_platform: 'mobile_android',
    vk_user_id: '777',
    sign: 'broken-signature',
  });

  assert.throws(
    () => verifyVkLaunchParams(params.toString(), secret, 86_400),
    /invalid sign/
  );
});

test('verifyVkLaunchParams checks max age by vk_ts', () => {
  const secret = 'vk_secret_123';
  const ts = Math.floor(Date.now() / 1000) - 120;
  const params = new URLSearchParams({
    vk_app_id: '123456',
    vk_platform: 'mobile_android',
    vk_ts: String(ts),
    vk_user_id: '777',
  });
  params.set('sign', createSign(params, secret));

  assert.throws(
    () => verifyVkLaunchParams(params.toString(), secret, 60),
    /auth date expired/
  );
});

test('verifyVkLaunchParams works without app secret', () => {
  const params = new URLSearchParams({
    vk_app_id: '123456',
    vk_platform: 'mobile_android',
    vk_user_id: '777',
    sign: 'not-validated-without-secret',
  });

  const payload = verifyVkLaunchParams(params.toString(), '', 86_400);
  assert.equal(payload.vk_user_id, '777');
});

test('extractVkLaunchParams handles query, hash and full URL', () => {
  const fromQuery = extractVkLaunchParams('vk_user_id=1&sign=s');
  assert.equal(fromQuery.get('vk_user_id'), '1');

  const fromHash = extractVkLaunchParams('#/home?vk_user_id=2&sign=s2');
  assert.equal(fromHash.get('vk_user_id'), '2');

  const fromUrl = extractVkLaunchParams(
    'https://example.com/app?vk_user_id=3&sign=s3#/screen'
  );
  assert.equal(fromUrl.get('vk_user_id'), '3');
});

test('isVkLaunchParamsPayload recognizes required keys', () => {
  assert.equal(isVkLaunchParamsPayload('vk_user_id=123&sign=abc'), true);
  assert.equal(isVkLaunchParamsPayload('vk_user_id=123'), false);
  assert.equal(isVkLaunchParamsPayload('hash=telegram_data'), false);
});
