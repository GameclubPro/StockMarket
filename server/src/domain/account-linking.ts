export type RuntimePlatform = 'TELEGRAM' | 'VK';

export type MergeCandidateUser = {
  id: string;
  firstAuthAt: Date | null;
  createdAt: Date;
  isBlocked: boolean;
  blockedAt: Date | null;
  blockedUntil: Date | null;
  blockReason: string | null;
};

export type AccountLinkResult = {
  performed: boolean;
  merged: boolean;
  sourcePlatform?: RuntimePlatform;
  targetPlatform?: RuntimePlatform;
};

export type MergedBlockState = {
  isBlocked: boolean;
  blockedAt: Date | null;
  blockedUntil: Date | null;
  blockReason: string | null;
};

const getChronologyStamp = (user: Pick<MergeCandidateUser, 'firstAuthAt' | 'createdAt'>) =>
  user.firstAuthAt?.getTime() ?? user.createdAt.getTime();

const pickEarlierUser = <T extends Pick<MergeCandidateUser, 'id' | 'firstAuthAt' | 'createdAt'>>(
  left: T,
  right: T
) => {
  const leftStamp = getChronologyStamp(left);
  const rightStamp = getChronologyStamp(right);
  if (leftStamp !== rightStamp) {
    return leftStamp < rightStamp ? left : right;
  }
  return left.id.localeCompare(right.id) <= 0 ? left : right;
};

const pickEarlierDate = (dates: Array<Date | null | undefined>) => {
  let chosen: Date | null = null;
  for (const date of dates) {
    if (!date) continue;
    if (!chosen || date.getTime() < chosen.getTime()) chosen = date;
  }
  return chosen;
};

export const pickMasterUserId = (payload: {
  userA: Pick<MergeCandidateUser, 'id' | 'firstAuthAt' | 'createdAt'>;
  userB: Pick<MergeCandidateUser, 'id' | 'firstAuthAt' | 'createdAt'>;
  hasTelegramA: boolean;
  hasTelegramB: boolean;
}) => {
  if (payload.hasTelegramA && !payload.hasTelegramB) return payload.userA.id;
  if (payload.hasTelegramB && !payload.hasTelegramA) return payload.userB.id;
  return pickEarlierUser(payload.userA, payload.userB).id;
};

export const resolveMergedBlockState = (
  masterUser: MergeCandidateUser,
  secondaryUser: MergeCandidateUser
): MergedBlockState | null => {
  const blockedUsers = [masterUser, secondaryUser].filter((item) => item.isBlocked);
  if (blockedUsers.length === 0) return null;

  const blockedAt = pickEarlierDate(blockedUsers.map((item) => item.blockedAt));

  const permanentUsers = blockedUsers.filter((item) => !item.blockedUntil);
  if (permanentUsers.length > 0) {
    const selected = permanentUsers.reduce((best, current) => pickEarlierUser(best, current));
    const fallbackReason = blockedUsers.find((item) => item.blockReason)?.blockReason ?? null;
    return {
      isBlocked: true,
      blockedAt,
      blockedUntil: null,
      blockReason: selected.blockReason ?? fallbackReason,
    };
  }

  const selected = blockedUsers.reduce((best, current) => {
    const bestUntil = best.blockedUntil;
    const currentUntil = current.blockedUntil;
    if (!bestUntil) return current;
    if (!currentUntil) return best;
    if (currentUntil.getTime() > bestUntil.getTime()) return current;
    if (currentUntil.getTime() < bestUntil.getTime()) return best;
    return pickEarlierUser(best, current);
  });

  const fallbackReason = blockedUsers.find((item) => item.blockReason)?.blockReason ?? null;
  return {
    isBlocked: true,
    blockedAt,
    blockedUntil: selected.blockedUntil ?? null,
    blockReason: selected.blockReason ?? fallbackReason,
  };
};

export const buildAccountLinkResult = (
  targetPlatform?: RuntimePlatform,
  merged = false
): AccountLinkResult => {
  if (!targetPlatform) {
    return {
      performed: false,
      merged: false,
    };
  }

  return {
    performed: true,
    merged,
    sourcePlatform: targetPlatform === 'VK' ? 'TELEGRAM' : 'VK',
    targetPlatform,
  };
};
