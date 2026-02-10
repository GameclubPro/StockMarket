export const DAILY_BONUS_REASON = 'Ежедневный бонус';
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const DAILY_BONUS_COOLDOWN_MS = ONE_DAY_MS;

export const DAILY_BONUS_SEGMENTS = [
  { label: '+10', value: 10, weight: 2 },
  { label: '+10', value: 10, weight: 2 },
  { label: '+20', value: 20, weight: 2 },
  { label: '+50', value: 50, weight: 1 },
  { label: '+15', value: 15, weight: 3 },
  { label: '+50', value: 50, weight: 1 },
  { label: '+10', value: 10, weight: 3 },
  { label: '+100', value: 100, weight: 1 },
] as const;

export type DailyBonusReward = {
  index: number;
  value: number;
  label: string;
};

export const pickDailyBonus = (rng: () => number = Math.random): DailyBonusReward => {
  const totalWeight = DAILY_BONUS_SEGMENTS.reduce((sum, item) => sum + item.weight, 0);
  const roll = rng() * totalWeight;
  let cursor = 0;
  for (let index = 0; index < DAILY_BONUS_SEGMENTS.length; index += 1) {
    cursor += DAILY_BONUS_SEGMENTS[index].weight;
    if (roll <= cursor) {
      const reward = DAILY_BONUS_SEGMENTS[index];
      return { index, value: reward.value, label: reward.label };
    }
  }
  const fallback = DAILY_BONUS_SEGMENTS[0];
  return { index: 0, value: fallback.value, label: fallback.label };
};

export const getNextDailyBonusAt = (lastSpinAt: Date | null) =>
  lastSpinAt ? new Date(lastSpinAt.getTime() + DAILY_BONUS_COOLDOWN_MS) : null;

export const isDailyBonusAvailable = (lastSpinAt: Date | null, nowMs = Date.now()) => {
  const nextAvailableAt = getNextDailyBonusAt(lastSpinAt);
  return !nextAvailableAt || nowMs >= nextAvailableAt.getTime();
};

const toUtcDayNumber = (value: Date) =>
  Math.floor(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / ONE_DAY_MS);

export const calculateDailyBonusStreakFromDates = (entries: Date[]) => {
  if (!entries.length) return 0;

  const uniqueDays = [...entries]
    .map(toUtcDayNumber)
    .sort((a, b) => b - a)
    .filter((day, index, list) => index === 0 || day !== list[index - 1]);

  if (!uniqueDays.length) return 0;

  let streak = 1;
  for (let i = 1; i < uniqueDays.length; i += 1) {
    if (uniqueDays[i] === uniqueDays[i - 1] - 1) {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
};
