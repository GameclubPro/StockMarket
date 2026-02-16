import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAccountLinkResult,
  pickMasterUserId,
  resolveMergedBlockState,
  type MergeCandidateUser,
} from './account-linking.js';

const makeUser = (overrides: Partial<MergeCandidateUser> = {}): MergeCandidateUser => ({
  id: overrides.id ?? 'user',
  firstAuthAt: overrides.firstAuthAt ?? null,
  createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
  isBlocked: overrides.isBlocked ?? false,
  blockedAt: overrides.blockedAt ?? null,
  blockedUntil: overrides.blockedUntil ?? null,
  blockReason: overrides.blockReason ?? null,
});

test('pickMasterUserId keeps telegram identity as priority', () => {
  const userA = makeUser({ id: 'a', createdAt: new Date('2026-01-02T00:00:00.000Z') });
  const userB = makeUser({ id: 'b', createdAt: new Date('2026-01-01T00:00:00.000Z') });
  const masterId = pickMasterUserId({
    userA,
    userB,
    hasTelegramA: false,
    hasTelegramB: true,
  });
  assert.equal(masterId, 'b');
});

test('pickMasterUserId uses firstAuthAt/createdAt tie-break when telegram identity is equal', () => {
  const userA = makeUser({
    id: 'a',
    firstAuthAt: new Date('2026-01-03T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const userB = makeUser({
    id: 'b',
    firstAuthAt: new Date('2026-01-02T00:00:00.000Z'),
    createdAt: new Date('2026-01-04T00:00:00.000Z'),
  });

  const masterId = pickMasterUserId({
    userA,
    userB,
    hasTelegramA: true,
    hasTelegramB: true,
  });
  assert.equal(masterId, 'b');
});

test('resolveMergedBlockState picks permanent block over temporary', () => {
  const master = makeUser({
    id: 'master',
    isBlocked: true,
    blockedAt: new Date('2026-01-10T10:00:00.000Z'),
    blockedUntil: new Date('2026-01-20T10:00:00.000Z'),
    blockReason: 'temp',
  });
  const secondary = makeUser({
    id: 'secondary',
    isBlocked: true,
    blockedAt: new Date('2026-01-09T10:00:00.000Z'),
    blockedUntil: null,
    blockReason: 'perm',
  });

  const payload = resolveMergedBlockState(master, secondary);
  assert.equal(payload?.isBlocked, true);
  assert.equal(payload?.blockedUntil, null);
  assert.equal(payload?.blockReason, 'perm');
  assert.equal(payload?.blockedAt?.toISOString(), '2026-01-09T10:00:00.000Z');
});

test('resolveMergedBlockState picks maximum blockedUntil for temporary blocks', () => {
  const master = makeUser({
    id: 'master',
    isBlocked: true,
    blockedAt: new Date('2026-01-08T10:00:00.000Z'),
    blockedUntil: new Date('2026-01-18T10:00:00.000Z'),
    blockReason: 'master-temp',
  });
  const secondary = makeUser({
    id: 'secondary',
    isBlocked: true,
    blockedAt: new Date('2026-01-09T10:00:00.000Z'),
    blockedUntil: new Date('2026-01-22T10:00:00.000Z'),
    blockReason: 'secondary-temp',
  });

  const payload = resolveMergedBlockState(master, secondary);
  assert.equal(payload?.isBlocked, true);
  assert.equal(payload?.blockedUntil?.toISOString(), '2026-01-22T10:00:00.000Z');
  assert.equal(payload?.blockReason, 'secondary-temp');
  assert.equal(payload?.blockedAt?.toISOString(), '2026-01-08T10:00:00.000Z');
});

test('buildAccountLinkResult returns performed=false without target platform', () => {
  assert.deepEqual(buildAccountLinkResult(undefined, false), {
    performed: false,
    merged: false,
  });
});

test('buildAccountLinkResult returns source/target metadata for linked account', () => {
  assert.deepEqual(buildAccountLinkResult('VK', true), {
    performed: true,
    merged: true,
    sourcePlatform: 'TELEGRAM',
    targetPlatform: 'VK',
  });
});
