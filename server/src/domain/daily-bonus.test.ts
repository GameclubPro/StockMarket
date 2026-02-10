import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAILY_BONUS_COOLDOWN_MS,
  calculateDailyBonusStreakFromDates,
  getNextDailyBonusAt,
  isDailyBonusAvailable,
  pickDailyBonus,
} from './daily-bonus.js';

test('daily bonus cooldown is 24 hours', () => {
  assert.equal(DAILY_BONUS_COOLDOWN_MS, 24 * 60 * 60 * 1000);
});

test('isDailyBonusAvailable respects cooldown window', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const lastSpin = new Date(now - (24 * 60 * 60 * 1000 - 1));
  assert.equal(isDailyBonusAvailable(lastSpin, now), false);
  assert.equal(isDailyBonusAvailable(lastSpin, now + 1), true);
});

test('getNextDailyBonusAt adds cooldown duration', () => {
  const lastSpin = new Date('2026-01-15T12:00:00.000Z');
  const next = getNextDailyBonusAt(lastSpin);
  assert.equal(next?.toISOString(), '2026-01-16T12:00:00.000Z');
});

test('calculateDailyBonusStreakFromDates counts unique consecutive days', () => {
  const entries = [
    new Date('2026-01-16T20:00:00.000Z'),
    new Date('2026-01-16T08:00:00.000Z'),
    new Date('2026-01-15T23:00:00.000Z'),
    new Date('2026-01-14T10:00:00.000Z'),
    new Date('2026-01-12T09:00:00.000Z'),
  ];
  assert.equal(calculateDailyBonusStreakFromDates(entries), 3);
});

test('pickDailyBonus supports deterministic rng', () => {
  const first = pickDailyBonus(() => 0);
  const last = pickDailyBonus(() => 0.999999);

  assert.equal(first.index, 0);
  assert.equal(first.value, 10);
  assert.equal(last.index, 7);
  assert.equal(last.value, 100);
});
