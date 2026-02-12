import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAdminFineApplied, resolveAdminBlockUntil } from './moderation.js';

test('calculateAdminFineApplied clamps by balance and total earned', () => {
  assert.equal(
    calculateAdminFineApplied({
      requestedFine: 100,
      balance: 90,
      totalEarned: 80,
    }),
    80
  );

  assert.equal(
    calculateAdminFineApplied({
      requestedFine: 40,
      balance: 100,
      totalEarned: 100,
    }),
    40
  );
});

test('resolveAdminBlockUntil computes temporary and permanent modes', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const temporary = resolveAdminBlockUntil({ mode: 'temporary', blockDays: 3, now });
  assert.equal(temporary?.toISOString(), '2026-01-04T00:00:00.000Z');

  const permanent = resolveAdminBlockUntil({ mode: 'permanent', now });
  assert.equal(permanent, null);

  const none = resolveAdminBlockUntil({ mode: 'none', now });
  assert.equal(none, undefined);
});
