export type RuntimePlatform = 'TELEGRAM' | 'VK';

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
  platform: RuntimePlatform;
  createdAt: string;
};

export type CampaignDto = {
  id: string;
  platform: RuntimePlatform;
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

export type SwitchLinkResponse = {
  ok: true;
  url: string;
  code: string;
  expiresAt: string;
};

export type CampaignReportReason =
  | 'SPAM_SCAM'
  | 'FAKE_TASK'
  | 'BROKEN_LINK'
  | 'PROHIBITED_CONTENT'
  | 'OTHER';

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

export type BlockedPayload = {
  reason: string | null;
  blockedUntil: string | null;
  isPermanent: boolean;
};

export type AdminComplaintItem = {
  campaignId: string;
  reportCount: number;
  lastReportedAt: string;
  topReason: CampaignReportReason;
  topReasonLabel: string;
  campaign: {
    id: string;
    groupTitle: string;
    actionType: 'SUBSCRIBE' | 'REACTION';
    createdAt: string;
    totalBudget: number;
    remainingBudget: number;
  };
  owner: {
    id: string;
    label: string;
    isBlocked: boolean;
    blockedUntil: string | null;
  };
  sampleReporters: string[];
};

export type AdminModerationSnapshot = {
  summary: {
    openReports: number;
    stalePendingCount: number;
    blockedUsersCount: number;
    updatedAt: string;
  };
  complaints: AdminComplaintItem[];
  stale: {
    thresholdHours: number;
    count: number;
    oldestCreatedAt: string | null;
  };
  blockedUsers: Array<{
    id: string;
    label: string;
    blockedAt: string;
    blockedUntil: string | null;
    blockReason: string | null;
  }>;
};

export type AdminModerationActionPayload = {
  deleteCampaign?: boolean;
  finePoints?: number;
  fineReason?: string;
  blockMode?: 'none' | 'temporary' | 'permanent';
  blockDays?: number;
  blockReason?: string;
};

export type AdminPanelStats = {
  period: {
    preset: 'today' | '7d' | '30d';
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    updatedAt: string;
  };
  overview: {
    newUsers: number;
    totalUsers: number;
    activeUsers: number;
    activeCampaigns: number;
    pendingApplications: number;
    reviewedApplications: number;
    approvedApplications: number;
    rejectedApplications: number;
    approvalRate: number;
    pointsIssued: number;
    pointsSpent: number;
    pointsNet: number;
    welcomeBonusAmount: number;
    welcomeBonusGranted: number;
    welcomeBonusLimit: number;
    welcomeBonusRemaining: number;
  };
  trends: {
    newUsers: {
      current: number;
      previous: number;
      delta: number;
      deltaPct: number | null;
      direction: 'up' | 'down' | 'flat';
    };
    pointsIssued: {
      current: number;
      previous: number;
      delta: number;
      deltaPct: number | null;
      direction: 'up' | 'down' | 'flat';
    };
    reviewedApplications: {
      current: number;
      previous: number;
      delta: number;
      deltaPct: number | null;
      direction: 'up' | 'down' | 'flat';
    };
  };
  campaigns: {
    createdInPeriod: number;
    activeCount: number;
    pausedCount: number;
    completedCount: number;
    lowBudgetCount: number;
    topCampaigns: Array<{
      id: string;
      groupTitle: string;
      ownerLabel: string;
      actionType: 'SUBSCRIBE' | 'REACTION';
      status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
      spentBudget: number;
      totalBudget: number;
      remainingBudget: number;
      rewardPoints: number;
      approvalRate: number;
    }>;
  };
  applications: {
    pendingCount: number;
    stalePendingCount: number;
    reviewedInPeriod: number;
    avgReviewMinutes: number;
    recentPending: Array<{
      id: string;
      createdAt: string;
      applicantLabel: string;
      campaignId: string;
      campaignLabel: string;
      ownerLabel: string;
    }>;
    recentReviewed: Array<{
      id: string;
      status: 'APPROVED' | 'REJECTED';
      createdAt: string;
      reviewedAt: string;
      applicantLabel: string;
      campaignId: string;
      campaignLabel: string;
      ownerLabel: string;
    }>;
  };
  economy: {
    issuedPoints: number;
    spentPoints: number;
    netPoints: number;
    topCredits: Array<{
      id: string;
      amount: number;
      reason: string;
      userLabel: string;
      createdAt: string;
    }>;
    topDebits: Array<{
      id: string;
      amount: number;
      reason: string;
      userLabel: string;
      createdAt: string;
    }>;
  };
  referrals: {
    invitedInPeriod: number;
    rewardsInPeriod: number;
    topReferrers: Array<{
      userId: string;
      userLabel: string;
      rewards: number;
      invited: number;
    }>;
  };
  risks: {
    highRejectOwners: Array<{
      userId: string;
      ownerLabel: string;
      reviewed: number;
      rejected: number;
      rejectRate: number;
    }>;
    suspiciousApplicants: Array<{
      userId: string;
      userLabel: string;
      applications: number;
      approved: number;
      approveRate: number;
    }>;
    reports: {
      totalInPeriod: number;
      byReason: Array<{
        reason: CampaignReportReason;
        reasonLabel: string;
        count: number;
      }>;
      recent: Array<{
        id: string;
        campaignId: string;
        reason: CampaignReportReason;
        reasonLabel: string;
        reporterLabel: string;
        groupTitle: string;
        actionType: 'SUBSCRIBE' | 'REACTION';
        createdAt: string;
      }>;
    };
  };
  alerts: Array<{
    level: 'info' | 'warning' | 'critical';
    message: string;
  }>;
  // legacy fields
  newUsersToday: number;
  totalUsers: number;
  bonusAmount: number;
  bonusGranted: number;
  bonusLimit: number;
  bonusRemaining: number;
  periodStart: string;
  periodEnd: string;
  updatedAt: string;
};
