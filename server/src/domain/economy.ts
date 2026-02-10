export const PLATFORM_FEE_RATE = 0.3;

export const RANKS = [
  { level: 0, minTotal: 0, title: 'Новичок', bonusRate: 0 },
  { level: 1, minTotal: 100, title: 'Бронза', bonusRate: 0.05 },
  { level: 2, minTotal: 300, title: 'Серебро', bonusRate: 0.1 },
  { level: 3, minTotal: 1000, title: 'Золото', bonusRate: 0.15 },
  { level: 4, minTotal: 3000, title: 'Платина', bonusRate: 0.2 },
  { level: 5, minTotal: 5000, title: 'Алмаз', bonusRate: 0.3 },
] as const;

export type RankTier = (typeof RANKS)[number];

export const getRankByTotal = (totalEarned: number): RankTier => {
  let current: RankTier = RANKS[0];
  for (const rank of RANKS) {
    if (totalEarned >= rank.minTotal) current = rank;
  }
  return current;
};

export const calculateBasePayout = (rewardPoints: number) => {
  const payout = Math.round(rewardPoints * (1 - PLATFORM_FEE_RATE));
  return Math.max(1, Math.min(rewardPoints, payout));
};

export const calculatePayoutWithBonus = (rewardPoints: number, bonusRate: number) => {
  const base = calculateBasePayout(rewardPoints);
  const bonus = Math.round(base * bonusRate);
  return Math.max(1, Math.min(rewardPoints, base + bonus));
};

export const calculateUnsubscribePenalty = (payload: {
  currentBalance: number;
  currentTotalEarned: number;
  earnedAmount: number;
  multiplier?: number;
}) => {
  const multiplier = Math.max(1, Math.floor(payload.multiplier ?? 2));
  const currentBalance = Math.max(0, Math.floor(payload.currentBalance));
  const currentTotalEarned = Math.max(0, Math.floor(payload.currentTotalEarned));
  const earnedAmount = Math.max(0, Math.floor(payload.earnedAmount));
  const rawPenalty = earnedAmount * multiplier;
  const appliedPenalty = Math.min(rawPenalty, currentBalance, currentTotalEarned);

  return {
    rawPenalty,
    appliedPenalty,
    nextBalance: currentBalance - appliedPenalty,
    nextTotalEarned: currentTotalEarned - appliedPenalty,
  };
};
