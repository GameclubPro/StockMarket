export type AdminBlockMode = 'none' | 'temporary' | 'permanent';

export const calculateAdminFineApplied = (payload: {
  requestedFine: number;
  balance: number;
  totalEarned: number;
}) => {
  const requestedFine = Math.max(0, Math.floor(payload.requestedFine));
  const balance = Math.max(0, Math.floor(payload.balance));
  const totalEarned = Math.max(0, Math.floor(payload.totalEarned));
  return Math.min(requestedFine, balance, totalEarned);
};

export const resolveAdminBlockUntil = (payload: {
  mode: AdminBlockMode;
  blockDays?: number;
  now?: Date;
}) => {
  const now = payload.now ?? new Date();
  if (payload.mode === 'temporary') {
    const days = Math.max(1, Math.floor(payload.blockDays ?? 1));
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  }
  if (payload.mode === 'permanent') {
    return null;
  }
  return undefined;
};
