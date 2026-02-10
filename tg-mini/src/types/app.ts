export type UserDto = {
  id: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  totalEarned?: number | null;
};

export type GroupDto = {
  id: string;
  title: string;
  username?: string | null;
  telegramChatId?: string | null;
  inviteLink: string;
  description?: string | null;
  category?: string | null;
  createdAt: string;
};

export type CampaignDto = {
  id: string;
  actionType: 'SUBSCRIBE' | 'REACTION';
  targetMessageId?: number | null;
  rewardPoints: number;
  totalBudget: number;
  remainingBudget: number;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  createdAt: string;
  group: GroupDto;
  owner?: UserDto;
};

export type ApplicationDto = {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
  createdAt: string;
  reviewedAt?: string | null;
  campaign: CampaignDto;
  applicant?: UserDto;
};

export type DailyBonusStatus = {
  available: boolean;
  lastSpinAt?: string | null;
  nextAvailableAt?: string | null;
  cooldownMs?: number;
  streak?: number;
};

export type DailyBonusSpin = {
  reward: { index: number; value: number; label: string };
  balance: number;
  totalEarned: number;
  lastSpinAt: string;
  nextAvailableAt: string;
  cooldownMs: number;
  streak?: number;
};

export type ReferralBonus = {
  amount: number;
  reason: string;
};

export type ReferralStats = {
  code: string;
  link: string;
  stats: {
    invited: number;
    earned: number;
  };
};

export type ReferralListItem = {
  id: string;
  createdAt: string;
  completedOrders: number;
  earned: number;
  referredUser: UserDto;
};

export type AdminPanelStats = {
  newUsersToday: number;
  totalUsers: number;
  bonusGranted: number;
  bonusLimit: number;
  bonusRemaining: number;
  periodStart: string;
  periodEnd: string;
  updatedAt: string;
};
