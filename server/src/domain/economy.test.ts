import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculatePayoutWithBonus,
  calculateUnsubscribePenalty,
  getRankByTotal,
} from './economy.js';

test('getRankByTotal returns correct tier at boundaries', () => {
  assert.equal(getRankByTotal(0).title, 'Новичок');
  assert.equal(getRankByTotal(100).title, 'Бронза');
  assert.equal(getRankByTotal(299).title, 'Бронза');
  assert.equal(getRankByTotal(300).title, 'Серебро');
  assert.equal(getRankByTotal(5000).title, 'Алмаз');
});

test('calculatePayoutWithBonus is bounded by rewardPoints', () => {
  assert.equal(calculatePayoutWithBonus(10, 0), 7);
  assert.equal(calculatePayoutWithBonus(10, 0.3), 9);
  assert.equal(calculatePayoutWithBonus(1, 0.3), 1);
  assert.equal(calculatePayoutWithBonus(50, 1), 50);
});

test('calculateUnsubscribePenalty clamps to balance and totalEarned', () => {
  const result = calculateUnsubscribePenalty({
    currentBalance: 20,
    currentTotalEarned: 15,
    earnedAmount: 20,
    multiplier: 2,
  });

  assert.equal(result.rawPenalty, 40);
  assert.equal(result.appliedPenalty, 15);
  assert.equal(result.nextBalance, 5);
  assert.equal(result.nextTotalEarned, 0);
});
