import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeApiError, toPublicErrorMessage } from './errors.js';

test('normalizeApiError maps common auth and business errors', () => {
  assert.equal(normalizeApiError(new Error('unauthorized')).status, 401);
  assert.equal(normalizeApiError(new Error('campaign paused')).status, 409);
  assert.equal(normalizeApiError(new Error('application not found')).status, 404);
  assert.equal(normalizeApiError(new Error('not owner')).status, 403);
  assert.equal(normalizeApiError(new Error('platform_link_code_invalid')).status, 400);
  assert.equal(normalizeApiError(new Error('user_blocked')).status, 423);
});

test('normalizeApiError respects explicit status from error object', () => {
  const error = { message: 'telegram_error', status: 429 };
  assert.equal(normalizeApiError(error).status, 429);
});

test('toPublicErrorMessage applies user-friendly replacements', () => {
  assert.equal(toPublicErrorMessage('insufficient_balance'), 'Недостаточно баллов.');
  assert.equal(toPublicErrorMessage('budget too small'), 'Бюджет меньше цены действия.');
  assert.equal(
    toPublicErrorMessage('platform_link_code_expired'),
    'Срок действия кода переключения истек.'
  );
  assert.equal(toPublicErrorMessage('user_blocked'), 'user_blocked');
  assert.equal(toPublicErrorMessage('unknown_error'), 'unknown_error');
});
