import crypto from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from './db.js';
import { type Prisma, type User } from '@prisma/client';
import { config } from './config.js';
import { signSession, verifySession } from './auth.js';
import {
  calculatePayoutWithBonus,
  calculateUnsubscribePenalty,
  getRankByTotal,
} from './domain/economy.js';
import {
  DAILY_BONUS_COOLDOWN_MS,
  DAILY_BONUS_REASON,
  pickDailyBonus,
  calculateDailyBonusStreakFromDates,
  getNextDailyBonusAt,
  isDailyBonusAvailable,
} from './domain/daily-bonus.js';
import { normalizeApiError, toPublicErrorMessage } from './http/errors.js';
import { verifyInitData } from './telegram.js';
import {
  ensureBotIsAdmin,
  exportChatInviteLink,
  extractUsername,
  getBotInfo,
  getChatMemberStatus,
  isActiveMemberStatus,
  isAdminMemberStatus,
  sendMessage,
} from './telegram-bot.js';
import { handleBotWebhookUpdate, type TelegramUpdate } from './telegram-webhook.js';

const authBodySchema = z.object({
  initData: z.string().min(1),
});

const groupCreateSchema = z.object({
  title: z.string().min(3).max(80),
  username: z.string().max(64).optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  inviteLink: z.string().url(),
  description: z.string().max(500).optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  category: z.string().max(50).optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
});

const campaignCreateSchema = z.object({
  groupId: z.string().min(1),
  actionType: z.enum(['subscribe', 'reaction']),
  rewardPoints: z.coerce.number().int().min(1).max(10000),
  totalBudget: z.coerce.number().int().min(1).max(1000000),
  targetMessageLink: z.string().min(1).optional(),
});

const campaignQuerySchema = z.object({
  category: z.string().max(50).optional(),
  actionType: z.enum(['subscribe', 'reaction']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const REFERRAL_MILESTONES = [
  {
    milestone: 'JOIN',
    orders: 0,
    referrer: 10,
    referred: 10,
    reasonReferrer: 'Реферальный бонус: вход друга',
    reasonReferred: 'Бонус за вход по приглашению',
  },
  {
    milestone: 'ORDERS_5',
    orders: 5,
    referrer: 30,
    referred: 30,
    reasonReferrer: 'Реферальный бонус: 5 заказов',
    reasonReferred: 'Бонус за 5 заказов',
  },
  {
    milestone: 'ORDERS_15',
    orders: 15,
    referrer: 60,
    referred: 0,
    reasonReferrer: 'Реферальный бонус: 15 заказов',
    reasonReferred: '',
  },
  {
    milestone: 'ORDERS_30',
    orders: 30,
    referrer: 100,
    referred: 0,
    reasonReferrer: 'Реферальный бонус: 30 заказов',
    reasonReferred: '',
  },
] as const;

const REFERRAL_JOIN_MILESTONE = REFERRAL_MILESTONES[0];
const REFERRAL_CODE_BYTES = 5;
const REFERRAL_CODE_ATTEMPTS = 6;

type DbClient = Prisma.TransactionClient | typeof prisma;
type ReferralMilestone = (typeof REFERRAL_MILESTONES)[number];

const generateReferralCode = () =>
  crypto.randomBytes(REFERRAL_CODE_BYTES).toString('hex').toUpperCase();

const normalizeReferralCode = (value: string) => value.trim().toUpperCase();
const isValidReferralCode = (value: string) => /^[A-Z0-9]{6,20}$/.test(value);

const createUniqueReferralCode = async (db: DbClient) => {
  for (let attempt = 0; attempt < REFERRAL_CODE_ATTEMPTS; attempt += 1) {
    const code = generateReferralCode();
    const existing = await db.user.findUnique({ where: { referralCode: code } });
    if (!existing) return code;
  }
  throw new Error('referral_code_collision');
};

const ensureReferralCodeForUser = async (
  db: DbClient,
  payload: { userId: string; current?: string | null }
) => {
  const current = payload.current?.trim();
  if (current) return current;
  const code = await createUniqueReferralCode(db);
  const updated = await db.user.update({
    where: { id: payload.userId },
    data: { referralCode: code },
    select: { referralCode: true },
  });
  return updated.referralCode ?? code;
};

const linkReferralByCode = async (
  tx: Prisma.TransactionClient,
  payload: { referredUserId: string; referralCode: string; requireNoFirstAuth?: boolean }
) => {
  const normalized = normalizeReferralCode(payload.referralCode);
  if (!isValidReferralCode(normalized)) return null;

  const referred = await tx.user.findUnique({
    where: { id: payload.referredUserId },
    select: { id: true, firstAuthAt: true },
  });
  if (!referred) return null;
  if (payload.requireNoFirstAuth && referred.firstAuthAt) return null;

  const existing = await tx.referral.findUnique({
    where: { referredUserId: payload.referredUserId },
    select: { id: true },
  });
  if (existing) return null;

  const referrer = await tx.user.findUnique({
    where: { referralCode: normalized },
    select: { id: true },
  });
  if (!referrer || referrer.id === payload.referredUserId) return null;

  const referral = await tx.referral.create({
    data: {
      referrerId: referrer.id,
      referredUserId: payload.referredUserId,
      completedOrders: 0,
    },
  });

  const reward = await awardReferralMilestone(tx, referral, REFERRAL_JOIN_MILESTONE);
  const referredBonus =
    reward.referredGranted && REFERRAL_JOIN_MILESTONE.referred > 0
      ? {
          amount: REFERRAL_JOIN_MILESTONE.referred,
          reason:
            REFERRAL_JOIN_MILESTONE.reasonReferred || REFERRAL_JOIN_MILESTONE.reasonReferrer,
        }
      : null;

  return { referral, referredBonus };
};

const grantReferralReward = async (
  tx: Prisma.TransactionClient,
  payload: {
    referralId: string;
    userId: string;
    side: 'REFERRER' | 'REFERRED';
    milestone: 'JOIN' | 'ORDERS_5' | 'ORDERS_15' | 'ORDERS_30';
    amount: number;
    reason: string;
  }
) => {
  if (payload.amount <= 0) return false;
  const existing = await tx.referralReward.findUnique({
    where: {
      referralId_side_milestone: {
        referralId: payload.referralId,
        side: payload.side,
        milestone: payload.milestone,
      },
    },
    select: { id: true },
  });
  if (existing) return false;

  await tx.referralReward.create({
    data: {
      referralId: payload.referralId,
      side: payload.side,
      milestone: payload.milestone,
      amount: payload.amount,
    },
  });

  await tx.user.update({
    where: { id: payload.userId },
    data: {
      balance: { increment: payload.amount },
      totalEarned: { increment: payload.amount },
    },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: payload.userId,
      type: 'EARN',
      amount: payload.amount,
      reason: payload.reason,
    },
  });

  return true;
};

const awardReferralMilestone = async (
  tx: Prisma.TransactionClient,
  referral: { id: string; referrerId: string; referredUserId: string },
  milestone: ReferralMilestone
) => {
  const referrerGranted = await grantReferralReward(tx, {
    referralId: referral.id,
    userId: referral.referrerId,
    side: 'REFERRER',
    milestone: milestone.milestone,
    amount: milestone.referrer,
    reason: milestone.reasonReferrer,
  });
  let referredGranted = false;
  if (milestone.referred > 0) {
    referredGranted = await grantReferralReward(tx, {
      referralId: referral.id,
      userId: referral.referredUserId,
      side: 'REFERRED',
      milestone: milestone.milestone,
      amount: milestone.referred,
      reason: milestone.reasonReferred || milestone.reasonReferrer,
    });
  }
  return { referrerGranted, referredGranted };
};

const updateReferralProgress = async (
  tx: Prisma.TransactionClient,
  payload: { userId: string; delta: number }
) => {
  if (!payload.delta) return;
  const referral = await tx.referral.findUnique({
    where: { referredUserId: payload.userId },
    select: { id: true, referrerId: true, referredUserId: true, completedOrders: true },
  });
  if (!referral) return;

  const nextCount = Math.max(0, referral.completedOrders + payload.delta);
  if (nextCount === referral.completedOrders) return;

  await tx.referral.update({
    where: { id: referral.id },
    data: { completedOrders: nextCount },
  });

  if (payload.delta < 0) return;

  for (const milestone of REFERRAL_MILESTONES) {
    if (milestone.orders <= 0) continue;
    if (nextCount < milestone.orders) continue;
    await awardReferralMilestone(tx, referral, milestone);
  }
};

const getDailyBonusWindow = async (tx: Prisma.TransactionClient, userId: string) => {
  const lastEntry = await tx.ledgerEntry.findFirst({
    where: { userId, reason: DAILY_BONUS_REASON },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const lastSpinAt = lastEntry?.createdAt ?? null;
  const nextAvailableAt = getNextDailyBonusAt(lastSpinAt);
  const available = isDailyBonusAvailable(lastSpinAt);
  return { available, lastSpinAt, nextAvailableAt };
};

const calculateDailyBonusStreak = async (tx: Prisma.TransactionClient, userId: string) => {
  const entries = await tx.ledgerEntry.findMany({
    where: { userId, reason: DAILY_BONUS_REASON },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { createdAt: true },
  });
  return calculateDailyBonusStreakFromDates(entries.map((entry) => entry.createdAt));
};

const parseMessageLink = (value: string) => {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (!host.endsWith('t.me') && !host.endsWith('telegram.me')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (parts[0] === 'c') {
      if (parts.length < 3) return null;
      const internalId = parts[1];
      const messageId = Number(parts[2]);
      if (!/^\d+$/.test(internalId)) return null;
      if (!Number.isInteger(messageId) || messageId <= 0) return null;
      return { chatId: `-100${internalId}`, messageId };
    }
    const username = parts[0];
    const messageId = Number(parts[1]);
    if (!Number.isInteger(messageId) || messageId <= 0) return null;
    return { username, messageId };
  } catch {
    return null;
  }
};

const resolveChatIdentity = (chat?: { username?: string; id?: number }) => {
  const username = chat?.username?.trim() ?? '';
  const chatId = typeof chat?.id === 'number' ? String(chat.id) : '';
  return { username, chatId };
};

const findGroupByChat = async (chat?: { username?: string; id?: number }) => {
  const { username, chatId } = resolveChatIdentity(chat);
  if (username) {
    return await prisma.group.findFirst({ where: { username } });
  }
  if (chatId) {
    return await prisma.group.findFirst({ where: { telegramChatId: chatId } });
  }
  return null;
};

const getToken = (authHeader?: string) => {
  if (!authHeader) return '';
  const [type, token] = authHeader.split(' ');
  if (type?.toLowerCase() !== 'bearer') return '';
  return token ?? '';
};

const getOptionalUser = async (request: FastifyRequest) => {
  const authHeader =
    typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
  const bearer = getToken(authHeader);
  if (!bearer) return null;
  try {
    const payload = await verifySession(bearer);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return null;
    return await ensureLegacyStats(user);
  } catch {
    return null;
  }
};

const creditUserForCampaign = async (
  tx: Prisma.TransactionClient,
  payload: { userId: string; campaign: { id: string; rewardPoints: number }; reason: string }
) => {
  const user = await tx.user.findUnique({
    where: { id: payload.userId },
    select: { totalEarned: true },
  });
  if (!user) throw new Error('user not found');

  const bonusRate = getRankByTotal(user.totalEarned).bonusRate;
  const payout = calculatePayoutWithBonus(payload.campaign.rewardPoints, bonusRate);

  await tx.user.update({
    where: { id: payload.userId },
    data: {
      balance: { increment: payout },
      totalEarned: { increment: payout },
    },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: payload.userId,
      type: 'EARN',
      amount: payout,
      reason: payload.reason,
      campaignId: payload.campaign.id,
    },
  });

  await updateReferralProgress(tx, { userId: payload.userId, delta: 1 });

  return payout;
};

const applyUnsubscribePenalty = async (
  tx: Prisma.TransactionClient,
  payload: { userId: string; campaignId: string }
) => {
  const [user, earnedEntry] = await Promise.all([
    tx.user.findUnique({
      where: { id: payload.userId },
      select: { balance: true, totalEarned: true },
    }),
    tx.ledgerEntry.findFirst({
      where: { userId: payload.userId, campaignId: payload.campaignId, type: 'EARN' },
      orderBy: { createdAt: 'desc' },
      select: { amount: true },
    }),
  ]);

  if (!user || !earnedEntry) return null;

  const earnedAmount = Math.max(0, Math.abs(earnedEntry.amount));
  if (earnedAmount === 0) return null;

  const penaltyResult = calculateUnsubscribePenalty({
    currentBalance: user.balance,
    currentTotalEarned: user.totalEarned,
    earnedAmount,
    multiplier: 2,
  });
  if (penaltyResult.appliedPenalty <= 0) return null;

  await tx.user.update({
    where: { id: payload.userId },
    data: {
      balance: penaltyResult.nextBalance,
      totalEarned: penaltyResult.nextTotalEarned,
    },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: payload.userId,
      type: 'ADJUST',
      amount: -penaltyResult.appliedPenalty,
      reason: 'Отписка от группы',
      campaignId: payload.campaignId,
    },
  });

  await updateReferralProgress(tx, { userId: payload.userId, delta: -1 });

  return penaltyResult.appliedPenalty;
};

const ensureLegacyStats = async (user: User) => {
  const data: Prisma.UserUpdateInput = {};

  if (user.balance === 0) {
    const hasLedger = await prisma.ledgerEntry.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!hasLedger) data.balance = 30;
  }

  if (user.totalEarned === 0) {
    const aggregate = await prisma.ledgerEntry.aggregate({
      where: { userId: user.id, type: { in: ['EARN', 'ADJUST'] } },
      _sum: { amount: true },
    });
    const total = Math.max(0, aggregate._sum.amount ?? 0);
    if (total > 0) data.totalEarned = total;
  }

  if (!user.referralCode) {
    const code = await createUniqueReferralCode(prisma);
    data.referralCode = code;
  }

  if (Object.keys(data).length === 0) return user;
  return await prisma.user.update({ where: { id: user.id }, data });
};

const syncGroupAdminsForUser = async (user: User) => {
  const telegramId = Number(user.telegramId);
  if (!Number.isFinite(telegramId)) return;

  const candidates = await prisma.group.findMany({
    where: {
      OR: [{ username: { not: null } }, { telegramChatId: { not: null } }],
      admins: { none: { userId: user.id } },
    },
    select: { id: true, username: true, telegramChatId: true, ownerId: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  for (const group of candidates) {
    const chatId = group.username ?? group.telegramChatId ?? '';
    if (!chatId) continue;
    if (group.ownerId === user.id) {
      await prisma.groupAdmin.upsert({
        where: { groupId_userId: { groupId: group.id, userId: user.id } },
        update: {},
        create: { groupId: group.id, userId: user.id },
      });
      continue;
    }
    try {
      const status = await getChatMemberStatus(config.botToken, chatId, telegramId);
      if (!isAdminMemberStatus(status)) continue;
      await prisma.groupAdmin.upsert({
        where: { groupId_userId: { groupId: group.id, userId: user.id } },
        update: {},
        create: { groupId: group.id, userId: user.id },
      });
    } catch {
      // ignore lookup errors to keep response fast
    }
  }
};

const requireUser = async (request: FastifyRequest) => {
  const authHeader =
    typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
  const bearer = getToken(authHeader);
  if (bearer) {
    const payload = await verifySession(bearer);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new Error('user not found');
    return await ensureLegacyStats(user);
  }

  const initData = request.headers['x-init-data'];
  if (typeof initData === 'string') {
    const authData = verifyInitData(initData, config.botToken, config.maxAuthAgeSec);
    const tgUser = authData.user;
    if (!tgUser) throw new Error('no user');

    const user = await prisma.user.upsert({
      where: { telegramId: String(tgUser.id) },
      update: {
        username: tgUser.username,
        firstName: tgUser.first_name,
        lastName: tgUser.last_name,
        photoUrl: tgUser.photo_url,
      },
      create: {
        telegramId: String(tgUser.id),
        username: tgUser.username,
        firstName: tgUser.first_name,
        lastName: tgUser.last_name,
        photoUrl: tgUser.photo_url,
        balance: 30,
        totalEarned: 0,
        rating: 0,
      },
    });

    return await ensureLegacyStats(user);
  }

  throw new Error('unauthorized');
};

const sendRouteError = (reply: FastifyReply, error: unknown, fallbackStatus = 400) => {
  const normalized = normalizeApiError(error, fallbackStatus);
  return reply.code(normalized.status).send({
    ok: false,
    error: toPublicErrorMessage(normalized.message),
  });
};

const isRetryableWebhookError = (error: unknown) => {
  const status = Number((error as { status?: unknown } | null)?.status);
  if (Number.isFinite(status) && status >= 500) return true;

  const code = String((error as { code?: unknown } | null)?.code ?? '');
  if (['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'P1001', 'P1002'].includes(code)) {
    return true;
  }

  const message = String((error as { message?: unknown } | null)?.message ?? '').toLowerCase();
  if (
    message.includes('timeout') ||
    message.includes('connect') ||
    message.includes('connection') ||
    message.includes('database is unreachable')
  ) {
    return true;
  }

  return false;
};

export const registerRoutes = (app: FastifyInstance) => {
  app.get('/health', async () => ({ ok: true }));

  app.post('/telegram/webhook', async (request, reply) => {
    const secret = config.botWebhookSecret;
    const header = request.headers['x-telegram-bot-api-secret-token'];
    if (secret && header !== secret) {
      return reply.code(401).send({ ok: false });
    }

    const update = request.body as TelegramUpdate;
    const reaction = update.message_reaction;
    const reactionCount = update.message_reaction_count;
    if (reaction || reactionCount) {
      if (reactionCount?.chat) {
        const totalCount = Array.isArray(reactionCount.reactions)
          ? reactionCount.reactions.reduce(
              (sum, item) => sum + (Number.isFinite(item.total_count) ? item.total_count : 0),
              0
            )
          : 0;
        request.log.info(
          {
            kind: 'message_reaction_count',
            chatType: reactionCount.chat.type,
            chat: reactionCount.chat.username ?? reactionCount.chat.id,
            messageId: reactionCount.message_id,
            totalCount,
          },
          'telegram reaction update'
        );
      }
      if (reaction?.chat) {
        request.log.info(
          {
            kind: 'message_reaction',
            chatType: reaction.chat.type,
            chat: reaction.chat.username ?? reaction.chat.id,
            messageId: reaction.message_id,
            hasUser: Boolean(reaction.user),
          },
          'telegram reaction update'
        );
      }
    }
    try {
      const upsertUser = async (user: {
        id: number;
        username?: string;
        first_name?: string;
        last_name?: string;
        photo_url?: string;
      }) => {
        const created = await prisma.user.upsert({
          where: { telegramId: String(user.id) },
          update: {
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name,
            photoUrl: user.photo_url,
          },
          create: {
            telegramId: String(user.id),
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name,
            photoUrl: user.photo_url,
            balance: 30,
            totalEarned: 0,
            rating: 0,
          },
        });
        return ensureLegacyStats(created);
      };

      const result = await handleBotWebhookUpdate(update, {
        upsertUser,
        upsertGroup: async ({ ownerId, chat }) => {
          const usernameRaw = chat.username?.trim() ?? '';
          const username = usernameRaw ? usernameRaw.replace(/^@/, '') : '';
          const chatId = Number.isFinite(chat.id) ? String(chat.id) : '';
          if (!username && !chatId) return;

          const existing = username
            ? await prisma.group.findUnique({ where: { username } })
            : chatId
              ? await prisma.group.findUnique({ where: { telegramChatId: chatId } })
              : null;

          let inviteLink = '';
          if (username) {
            inviteLink = `https://t.me/${username}`;
          } else if (chatId) {
            try {
              inviteLink = await exportChatInviteLink(config.botToken, chatId);
            } catch {
              // fallback to internal link for members if invite export fails
              inviteLink = chatId.startsWith('-100')
                ? `https://t.me/c/${chatId.slice(4)}`
                : '';
            }
          }

          if (existing) {
            await prisma.group.update({
              where: { id: existing.id },
              data: {
                title: chat.title ?? existing.title,
                inviteLink: inviteLink || existing.inviteLink,
                username: username || existing.username,
                telegramChatId: chatId || existing.telegramChatId,
              },
            });
            await prisma.groupAdmin.upsert({
              where: { groupId_userId: { groupId: existing.id, userId: ownerId } },
              update: {},
              create: { groupId: existing.id, userId: ownerId },
            });
            return;
          }

          const created = await prisma.group.create({
            data: {
              ownerId,
              title: chat.title ?? (username || 'Группа'),
              username: username || null,
              telegramChatId: chatId || null,
              inviteLink: inviteLink || '',
              description: null,
              category: null,
            },
          });

          await prisma.groupAdmin.create({
            data: { groupId: created.id, userId: ownerId },
          });
        },
        handleReaction: async ({ chat, user, messageId }) => {
          const group = await findGroupByChat(chat);
          if (!group) return;
          const campaign = await prisma.campaign.findFirst({
            where: {
              groupId: group.id,
              actionType: 'REACTION',
              targetMessageId: messageId,
              status: 'ACTIVE',
              remainingBudget: { gt: 0 },
            },
          });
          if (!campaign) return;

          const applicant = await upsertUser(user);
          const application = await prisma.application.findUnique({
            where: {
              campaignId_applicantId: {
                campaignId: campaign.id,
                applicantId: applicant.id,
              },
            },
          });
          if (!application || application.status !== 'PENDING') return;

          await prisma.$transaction(async (tx) => {
            const freshCampaign = await tx.campaign.findUnique({ where: { id: campaign.id } });
            if (!freshCampaign || freshCampaign.status !== 'ACTIVE') return;
            if (freshCampaign.remainingBudget < freshCampaign.rewardPoints) return;

            await tx.application.update({
              where: { id: application.id },
              data: { status: 'APPROVED', reviewedAt: new Date() },
            });

            await tx.campaign.update({
              where: { id: freshCampaign.id },
              data: {
                remainingBudget: { decrement: freshCampaign.rewardPoints },
                status:
                  freshCampaign.remainingBudget - freshCampaign.rewardPoints <= 0
                    ? 'COMPLETED'
                    : freshCampaign.status,
              },
            });

            await creditUserForCampaign(tx, {
              userId: applicant.id,
              campaign: freshCampaign,
              reason: 'Реакция на пост',
            });
          });
        },
        handleReactionCount: async ({ chat, messageId, totalCount }) => {
          const group = await findGroupByChat(chat);
          if (!group) return;

          const campaigns = await prisma.campaign.findMany({
            where: {
              groupId: group.id,
              actionType: 'REACTION',
              targetMessageId: messageId,
              status: 'ACTIVE',
              remainingBudget: { gt: 0 },
            },
            orderBy: { createdAt: 'asc' },
          });
          if (campaigns.length === 0) return;

          for (const campaign of campaigns) {
            await prisma.$transaction(async (tx) => {
              const freshCampaign = await tx.campaign.findUnique({ where: { id: campaign.id } });
              if (!freshCampaign || freshCampaign.status !== 'ACTIVE') return;

              const lastCount = freshCampaign.reactionCount;
              await tx.campaign.update({
                where: { id: freshCampaign.id },
                data: { reactionCount: totalCount },
              });

              if (totalCount <= 0) return;

              const maxByBudget = Math.floor(
                freshCampaign.remainingBudget / freshCampaign.rewardPoints
              );
              if (maxByBudget <= 0) return;

              const effectiveLast =
                lastCount === null || lastCount === undefined ? totalCount - 1 : lastCount;
              const delta = totalCount - effectiveLast;
              if (delta <= 0) return;

              const maxApprove = Math.min(delta, maxByBudget);
              const pending = await tx.application.findMany({
                where: {
                  campaignId: freshCampaign.id,
                  status: 'PENDING',
                  reactionBaseline: { not: null, lt: totalCount },
                },
                orderBy: [{ reactionBaseline: 'desc' }, { createdAt: 'desc' }],
                take: maxApprove,
              });
              let toApprove = pending;
              if (toApprove.length < maxApprove) {
                const remaining = maxApprove - toApprove.length;
                const pendingUnknown = await tx.application.findMany({
                  where: {
                    campaignId: freshCampaign.id,
                    status: 'PENDING',
                    reactionBaseline: null,
                  },
                  orderBy: { createdAt: 'desc' },
                  take: remaining,
                });
                toApprove = toApprove.concat(pendingUnknown);
              }
              if (toApprove.length === 0) return;

              const approveCount = Math.min(maxApprove, toApprove.length);
              if (approveCount <= 0) return;
              toApprove = toApprove.slice(0, approveCount);
              const now = new Date();

              await tx.application.updateMany({
                where: { id: { in: toApprove.map((item) => item.id) } },
                data: { status: 'APPROVED', reviewedAt: now },
              });

              const spend = freshCampaign.rewardPoints * approveCount;
              const newRemaining = freshCampaign.remainingBudget - spend;

              await tx.campaign.update({
                where: { id: freshCampaign.id },
                data: {
                  remainingBudget: { decrement: spend },
                  status: newRemaining <= 0 ? 'COMPLETED' : freshCampaign.status,
                },
              });

              for (const application of toApprove) {
                await creditUserForCampaign(tx, {
                  userId: application.applicantId,
                  campaign: freshCampaign,
                  reason: 'Реакция на пост',
                });
              }
            });
          }
        },
        handleChatMember: async ({ chat, user, status }) => {
          if (user.is_bot) return;
          const isJoinStatus =
            status === 'member' || status === 'administrator' || status === 'creator';
          const isLeaveStatus = status === 'left' || status === 'kicked';
          if (!isJoinStatus && !isLeaveStatus) return;

          const group = await findGroupByChat(chat);
          if (!group) return;

          const applicant = await upsertUser(user);
          if (isJoinStatus) {
            const application = await prisma.application.findFirst({
              where: {
                applicantId: applicant.id,
                status: 'PENDING',
                campaign: {
                  groupId: group.id,
                  actionType: 'SUBSCRIBE',
                  status: 'ACTIVE',
                  remainingBudget: { gt: 0 },
                },
              },
              orderBy: { createdAt: 'desc' },
            });
            if (!application) return;

            await prisma.$transaction(async (tx) => {
              const freshCampaign = await tx.campaign.findUnique({
                where: { id: application.campaignId },
              });
              if (!freshCampaign || freshCampaign.status !== 'ACTIVE') return;
              if (freshCampaign.remainingBudget < freshCampaign.rewardPoints) return;

              await tx.application.update({
                where: { id: application.id },
                data: { status: 'APPROVED', reviewedAt: new Date() },
              });

              await tx.campaign.update({
                where: { id: freshCampaign.id },
                data: {
                  remainingBudget: { decrement: freshCampaign.rewardPoints },
                  status:
                    freshCampaign.remainingBudget - freshCampaign.rewardPoints <= 0
                      ? 'COMPLETED'
                      : freshCampaign.status,
                },
              });

              await creditUserForCampaign(tx, {
                userId: applicant.id,
                campaign: freshCampaign,
                reason: 'Вступление в группу',
              });
            });
            return;
          }

          if (isLeaveStatus) {
            const application = await prisma.application.findFirst({
              where: {
                applicantId: applicant.id,
                status: 'APPROVED',
                campaign: {
                  groupId: group.id,
                  actionType: 'SUBSCRIBE',
                },
              },
              orderBy: { reviewedAt: 'desc' },
            });
            if (!application) return;

            await prisma.$transaction(async (tx) => {
              const freshApplication = await tx.application.findUnique({
                where: { id: application.id },
              });
              if (!freshApplication || freshApplication.status !== 'APPROVED') return;

              await tx.application.update({
                where: { id: application.id },
                data: { status: 'REVOKED', reviewedAt: new Date() },
              });

              await applyUnsubscribePenalty(tx, {
                userId: applicant.id,
                campaignId: application.campaignId,
              });
            });
          }
        },
        handleStartPayload: async ({ chatId, user, startParam }) => {
          const referred = await upsertUser(user);
          if (referred.firstAuthAt) return;
          const linked = await prisma.$transaction(async (tx) => {
            return await linkReferralByCode(tx, {
              referredUserId: referred.id,
              referralCode: startParam,
              requireNoFirstAuth: true,
            });
          });
          if (linked?.referredBonus) {
            try {
              await sendMessage(
                config.botToken,
                String(chatId),
                `Вас пригласили! Вы получили +${linked.referredBonus.amount} баллов.`
              );
            } catch {
              // ignore notification errors
            }
          }
        },
      });
      return reply.send(result);
    } catch (error) {
      request.log.error(
        {
          err: error,
          retryable: isRetryableWebhookError(error),
        },
        'telegram webhook processing failed'
      );

      if (isRetryableWebhookError(error)) {
        return reply.code(500).send({ ok: false, error: 'webhook_retryable_error' });
      }

      return reply.code(200).send({ ok: false, error: 'webhook_non_retryable_error' });
    }
  });

  app.post('/auth/verify', async (request, reply) => {
    const parsed = authBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });

    try {
      const authData = verifyInitData(parsed.data.initData, config.botToken, config.maxAuthAgeSec);
      const tgUser = authData.user;
      if (!tgUser) return reply.code(401).send({ ok: false, error: 'no user' });

      const rawStartParam =
        typeof authData.start_param === 'string' ? normalizeReferralCode(authData.start_param) : '';
      const startParam = rawStartParam && isValidReferralCode(rawStartParam) ? rawStartParam : '';
      const now = new Date();

      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({
          where: { telegramId: String(tgUser.id) },
        });
        let current: User;
        let isFirstAuth = false;
        let referralBonus: { amount: number; reason: string } | null = null;

        if (existing) {
          const updateData: Prisma.UserUpdateInput = {
            username: tgUser.username,
            firstName: tgUser.first_name,
            lastName: tgUser.last_name,
            photoUrl: tgUser.photo_url,
          };
          if (!existing.firstAuthAt) {
            updateData.firstAuthAt = now;
            isFirstAuth = true;
          }
          current = await tx.user.update({ where: { id: existing.id }, data: updateData });
        } else {
          const referralCode = await createUniqueReferralCode(tx);
          current = await tx.user.create({
            data: {
              telegramId: String(tgUser.id),
              username: tgUser.username,
              firstName: tgUser.first_name,
              lastName: tgUser.last_name,
              photoUrl: tgUser.photo_url,
              balance: 30,
              totalEarned: 0,
              rating: 0,
              firstAuthAt: now,
              referralCode,
            },
          });
          isFirstAuth = true;
        }

        if (!current.referralCode) {
          current = await tx.user.update({
            where: { id: current.id },
            data: { referralCode: await createUniqueReferralCode(tx) },
          });
        }

        if (isFirstAuth && startParam) {
          const linked = await linkReferralByCode(tx, {
            referredUserId: current.id,
            referralCode: startParam,
          });
          if (linked?.referredBonus) {
            referralBonus = linked.referredBonus;
          }
        }

        return { user: current, referralBonus };
      });

      const ensuredUser = await ensureLegacyStats(result.user);

      let token = '';
      if (config.appSecret) {
        token = await signSession({
          sub: ensuredUser.id,
          tid: ensuredUser.telegramId,
          username: ensuredUser.username ?? undefined,
        });
      }

      return {
        ok: true,
        user: ensuredUser,
        balance: ensuredUser.balance,
        token,
        referralBonus: result.referralBonus,
      };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.get('/me', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const [groups, campaigns, applications] = await Promise.all([
        prisma.group.count({
          where: {
            OR: [{ ownerId: user.id }, { admins: { some: { userId: user.id } } }],
          },
        }),
        prisma.campaign.count({ where: { ownerId: user.id } }),
        prisma.application.count({ where: { applicantId: user.id } }),
      ]);
      return {
        ok: true,
        user,
        balance: user.balance,
        stats: { groups, campaigns, applications },
      };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/referrals/me', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const code = await ensureReferralCodeForUser(prisma, {
        userId: user.id,
        current: user.referralCode ?? null,
      });

      let link = '';
      if (config.botToken) {
        try {
          const bot = await getBotInfo(config.botToken);
          if (bot?.username) {
            link = `https://t.me/${bot.username}?start=${code}`;
          }
        } catch {
          // ignore bot lookup errors
        }
      }

      const [invited, rewards] = await Promise.all([
        prisma.referral.count({ where: { referrerId: user.id } }),
        prisma.referralReward.aggregate({
          where: { side: 'REFERRER', referral: { referrerId: user.id } },
          _sum: { amount: true },
        }),
      ]);

      return {
        ok: true,
        code,
        link,
        stats: {
          invited,
          earned: Math.max(0, rewards._sum.amount ?? 0),
        },
      };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/referrals/list', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const referrals = await prisma.referral.findMany({
        where: { referrerId: user.id },
        include: {
          referredUser: true,
          rewards: { where: { side: 'REFERRER' } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      const result = referrals.map((referral) => ({
        id: referral.id,
        createdAt: referral.createdAt.toISOString(),
        completedOrders: referral.completedOrders,
        referredUser: {
          id: referral.referredUser.id,
          username: referral.referredUser.username,
          firstName: referral.referredUser.firstName,
          lastName: referral.referredUser.lastName,
          photoUrl: referral.referredUser.photoUrl,
        },
        earned: referral.rewards.reduce((sum, item) => sum + item.amount, 0),
      }));

      return { ok: true, referrals: result };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/daily-bonus/status', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const [window, streak] = await Promise.all([
        getDailyBonusWindow(prisma, user.id),
        calculateDailyBonusStreak(prisma, user.id),
      ]);
      return {
        ok: true,
        available: window.available,
        lastSpinAt: window.lastSpinAt ? window.lastSpinAt.toISOString() : null,
        nextAvailableAt: window.nextAvailableAt ? window.nextAvailableAt.toISOString() : null,
        cooldownMs: DAILY_BONUS_COOLDOWN_MS,
        streak,
      };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.post('/daily-bonus/spin', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const result = await prisma.$transaction(async (tx) => {
        const window = await getDailyBonusWindow(tx, user.id);
        if (!window.available) {
          const cooldownError = new Error('cooldown') as Error & {
            status?: number;
            window?: { lastSpinAt: Date | null; nextAvailableAt: Date | null };
          };
          cooldownError.status = 429;
          cooldownError.window = {
            lastSpinAt: window.lastSpinAt,
            nextAvailableAt: window.nextAvailableAt,
          };
          throw cooldownError;
        }

        const reward = pickDailyBonus();
        const spinAt = new Date();

        const updatedUser = await tx.user.update({
          where: { id: user.id },
          data: {
            balance: { increment: reward.value },
            totalEarned: { increment: reward.value },
          },
        });

        await tx.ledgerEntry.create({
          data: {
            userId: user.id,
            type: 'EARN',
            amount: reward.value,
            reason: DAILY_BONUS_REASON,
            createdAt: spinAt,
          },
        });

        const nextAvailableAt = getNextDailyBonusAt(spinAt) ?? new Date(spinAt.getTime());
        const streak = await calculateDailyBonusStreak(tx, user.id);
        return { reward, updatedUser, spinAt, nextAvailableAt, streak };
      });

      return {
        ok: true,
        reward: result.reward,
        balance: result.updatedUser.balance,
        totalEarned: result.updatedUser.totalEarned,
        lastSpinAt: result.spinAt.toISOString(),
        nextAvailableAt: result.nextAvailableAt.toISOString(),
        cooldownMs: DAILY_BONUS_COOLDOWN_MS,
        streak: result.streak,
      };
    } catch (error) {
      const normalized = normalizeApiError(error, 401);
      if (normalized.status === 429) {
        const raw = error as { window?: { lastSpinAt?: Date | null; nextAvailableAt?: Date | null } };
        return reply.code(429).send({
          ok: false,
          error: 'Бонус еще не доступен.',
          lastSpinAt: raw.window?.lastSpinAt
            ? raw.window.lastSpinAt.toISOString()
            : null,
          nextAvailableAt: raw.window?.nextAvailableAt
            ? raw.window.nextAvailableAt.toISOString()
            : null,
          cooldownMs: DAILY_BONUS_COOLDOWN_MS,
        });
      }
      return sendRouteError(reply, normalized, 401);
    }
  });

  app.get('/groups/my', async (request, reply) => {
    try {
      const user = await requireUser(request);
      await syncGroupAdminsForUser(user);
      const groups = await prisma.group.findMany({
        where: {
          OR: [{ ownerId: user.id }, { admins: { some: { userId: user.id } } }],
        },
        orderBy: { createdAt: 'desc' },
      });
      return { ok: true, groups };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.post('/groups', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const parsed = groupCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });

      const resolvedUsername = extractUsername(parsed.data.username ?? parsed.data.inviteLink);
      if (!resolvedUsername) {
        return reply.code(400).send({
          ok: false,
          error: 'Укажите публичный @username (например, @my_channel).',
        });
      }

      await ensureBotIsAdmin(config.botToken, resolvedUsername);

      const telegramId = Number(user.telegramId);
      if (!Number.isFinite(telegramId)) {
        return reply.code(400).send({ ok: false, error: 'Не удалось определить Telegram ID.' });
      }
      const memberStatus = await getChatMemberStatus(
        config.botToken,
        resolvedUsername,
        telegramId
      );
      if (!isAdminMemberStatus(memberStatus)) {
        return reply
          .code(403)
          .send({ ok: false, error: 'Вы должны быть администратором канала/группы.' });
      }

      const cleanUsername = resolvedUsername.replace(/^@/, '');
      const group = await prisma.group.upsert({
        where: { username: cleanUsername },
        update: {
          title: parsed.data.title,
          inviteLink: parsed.data.inviteLink,
          description: parsed.data.description,
          category: parsed.data.category,
        },
        create: {
          ownerId: user.id,
          title: parsed.data.title,
          username: cleanUsername,
          inviteLink: parsed.data.inviteLink,
          description: parsed.data.description,
          category: parsed.data.category,
        },
      });

      await prisma.groupAdmin.upsert({
        where: { groupId_userId: { groupId: group.id, userId: user.id } },
        update: {},
        create: { groupId: group.id, userId: user.id },
      });

      return { ok: true, group };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/campaigns', async (request, reply) => {
    const parsed = campaignQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid query' });

    const { category, limit, actionType } = parsed.data;
    const viewer = await getOptionalUser(request);
    const campaigns = await prisma.campaign.findMany({
      where: {
        status: 'ACTIVE',
        remainingBudget: { gt: 0 },
        ownerId: viewer ? { not: viewer.id } : undefined,
        group: category ? { category } : undefined,
        actionType: actionType
          ? actionType === 'subscribe'
            ? 'SUBSCRIBE'
            : 'REACTION'
          : undefined,
      },
      include: {
        group: true,
        owner: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit ?? 30,
    });

    const filtered = campaigns.filter((item) => item.remainingBudget >= item.rewardPoints);
    return { ok: true, campaigns: filtered };
  });

  app.get('/campaigns/my', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const campaigns = await prisma.campaign.findMany({
        where: { ownerId: user.id },
        include: { group: true },
        orderBy: { createdAt: 'desc' },
      });
      return { ok: true, campaigns };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.post('/campaigns', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const parsed = campaignCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });

      if (parsed.data.totalBudget < parsed.data.rewardPoints) {
        return reply.code(400).send({ ok: false, error: 'budget too small' });
      }

      const group = await prisma.group.findUnique({
        where: { id: parsed.data.groupId },
        include: { admins: { where: { userId: user.id }, select: { userId: true } } },
      });
      if (!group) {
        return reply.code(404).send({ ok: false, error: 'group not found' });
      }

      let isGroupAdmin = group.ownerId === user.id || (group.admins?.length ?? 0) > 0;
      const groupChatId = group.username ?? group.telegramChatId ?? '';
      if (!isGroupAdmin && groupChatId) {
        const telegramId = Number(user.telegramId);
        if (Number.isFinite(telegramId)) {
          try {
            const status = await getChatMemberStatus(config.botToken, groupChatId, telegramId);
            if (isAdminMemberStatus(status)) {
              await prisma.groupAdmin.upsert({
                where: { groupId_userId: { groupId: group.id, userId: user.id } },
                update: {},
                create: { groupId: group.id, userId: user.id },
              });
              isGroupAdmin = true;
            }
          } catch {
            // ignore
          }
        }
      }
      if (!isGroupAdmin) {
        return reply.code(403).send({ ok: false, error: 'not admin' });
      }

      let targetMessageId: number | null = null;
      if (parsed.data.actionType === 'reaction') {
        if (!parsed.data.targetMessageLink) {
          return reply.code(400).send({
            ok: false,
            error:
              'Для реакций нужна ссылка на пост (формат https://t.me/username/123 или https://t.me/c/123456/789).',
          });
        }
        const parsedLink = parseMessageLink(parsed.data.targetMessageLink);
        if (!parsedLink) {
          return reply.code(400).send({
            ok: false,
            error:
              'Ссылка на пост некорректна. Нужен формат https://t.me/username/123 или https://t.me/c/123456/789.',
          });
        }
        const groupUsername = group.username?.trim();
        const groupChatId = group.telegramChatId?.trim();
        if (parsedLink.username) {
          if (!groupUsername) {
            return reply.code(400).send({
              ok: false,
              error: 'У группы нет публичного @username для проверки реакций.',
            });
          }
          if (parsedLink.username.toLowerCase() !== groupUsername.toLowerCase()) {
            return reply.code(400).send({
              ok: false,
              error: 'Ссылка на пост должна быть из выбранной группы/канала.',
            });
          }
        }
        if (parsedLink.chatId) {
          if (!groupChatId) {
            return reply.code(400).send({
              ok: false,
              error: 'У группы нет данных для приватной ссылки. Добавьте бота в группу заново.',
            });
          }
          if (parsedLink.chatId !== groupChatId) {
            return reply.code(400).send({
              ok: false,
              error: 'Ссылка на пост должна быть из выбранной группы/канала.',
            });
          }
        }
        if (!parsedLink.username && !parsedLink.chatId) {
          return reply.code(400).send({
            ok: false,
            error:
              'Ссылка на пост некорректна. Нужен формат https://t.me/username/123 или https://t.me/c/123456/789.',
          });
        }
        targetMessageId = parsedLink.messageId;
      }

      const campaign = await prisma.$transaction(async (tx) => {
        const fresh = await tx.user.findUnique({ where: { id: user.id } });
        if (!fresh || fresh.balance < parsed.data.totalBudget) {
          throw new Error('insufficient_balance');
        }

        await tx.user.update({
          where: { id: user.id },
          data: { balance: { decrement: parsed.data.totalBudget } },
        });

        const created = await tx.campaign.create({
          data: {
            groupId: parsed.data.groupId,
            ownerId: user.id,
            actionType: parsed.data.actionType === 'subscribe' ? 'SUBSCRIBE' : 'REACTION',
            targetMessageId,
            rewardPoints: parsed.data.rewardPoints,
            totalBudget: parsed.data.totalBudget,
            remainingBudget: parsed.data.totalBudget,
            status: 'ACTIVE',
          },
        });

        await tx.ledgerEntry.create({
          data: {
            userId: user.id,
            type: 'SPEND',
            amount: -parsed.data.totalBudget,
            reason: 'Бюджет кампании',
            campaignId: created.id,
          },
        });

        return created;
      });

      const balance = await prisma.user.findUnique({ where: { id: user.id } });
      return { ok: true, campaign, balance: balance?.balance ?? user.balance };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/apply', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const campaignId = request.params.id;
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        include: { group: true },
      });
      if (!campaign) return reply.code(404).send({ ok: false, error: 'campaign not found' });
      if (campaign.ownerId === user.id) {
        return reply.code(400).send({ ok: false, error: 'cannot apply own campaign' });
      }
      if (campaign.status !== 'ACTIVE' || campaign.remainingBudget < campaign.rewardPoints) {
        return reply
          .code(409)
          .send({ ok: false, error: 'Задание приостановлено или бюджет исчерпан.' });
      }

      let existing = await prisma.application.findUnique({
        where: { campaignId_applicantId: { campaignId, applicantId: user.id } },
      });
      if (existing?.status === 'APPROVED') {
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        return { ok: true, application: existing, balance: updatedUser?.balance ?? user.balance };
      }
      if (existing?.status === 'REJECTED') {
        return reply.code(400).send({ ok: false, error: 'Заявка отклонена.' });
      }
      if (existing?.status === 'REVOKED') {
        const data: Prisma.ApplicationUpdateInput = {
          status: 'PENDING',
          reviewedAt: null,
        };
        if (campaign.actionType === 'REACTION') {
          data.reactionBaseline = campaign.reactionCount ?? null;
        }
        existing = await prisma.application.update({ where: { id: existing.id }, data });
      }

      if (campaign.actionType === 'REACTION') {
        if (existing) return { ok: true, application: existing };
        const application = await prisma.application.create({
          data: {
            campaignId,
            applicantId: user.id,
            reactionBaseline: campaign.reactionCount ?? null,
          },
        });
        return { ok: true, application };
      }

      const chatId = campaign.group.username ?? campaign.group.telegramChatId ?? '';
      if (!chatId) {
        return reply
          .code(400)
          .send({ ok: false, error: 'У группы нет данных для проверки вступления.' });
      }

      const telegramId = Number(user.telegramId);
      if (!Number.isFinite(telegramId)) {
        return reply.code(400).send({ ok: false, error: 'Не удалось определить Telegram ID.' });
      }

      const status = await getChatMemberStatus(config.botToken, chatId, telegramId);
      if (!isActiveMemberStatus(status)) {
        if (existing) return { ok: true, application: existing };
        const application = await prisma.application.create({
          data: {
            campaignId,
            applicantId: user.id,
          },
        });
        return { ok: true, application };
      }

      const result = await prisma.$transaction(async (tx) => {
        const freshCampaign = await tx.campaign.findUnique({ where: { id: campaign.id } });
        if (!freshCampaign || freshCampaign.status !== 'ACTIVE') throw new Error('campaign paused');
        if (freshCampaign.remainingBudget < freshCampaign.rewardPoints) throw new Error('budget empty');

        const application = existing
          ? await tx.application.update({
              where: { id: existing.id },
              data: { status: 'APPROVED', reviewedAt: new Date() },
            })
          : await tx.application.create({
              data: {
                campaignId,
                applicantId: user.id,
                status: 'APPROVED',
                reviewedAt: new Date(),
              },
            });

        const updatedCampaign = await tx.campaign.update({
          where: { id: freshCampaign.id },
          data: {
            remainingBudget: { decrement: freshCampaign.rewardPoints },
            status:
              freshCampaign.remainingBudget - freshCampaign.rewardPoints <= 0
                ? 'COMPLETED'
                : freshCampaign.status,
          },
        });

        await creditUserForCampaign(tx, {
          userId: user.id,
          campaign: freshCampaign,
          reason: freshCampaign.actionType === 'REACTION' ? 'Реакция на пост' : 'Вступление в группу',
        });

        return { application, campaign: updatedCampaign };
      });

      const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
      return {
        ok: true,
        application: result.application,
        campaign: result.campaign,
        balance: updatedUser?.balance ?? user.balance,
      };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.get('/applications/my', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const applications = await prisma.application.findMany({
        where: { applicantId: user.id },
        include: { campaign: { include: { group: true, owner: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return { ok: true, applications };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.get('/applications/incoming', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const applications = await prisma.application.findMany({
        where: { campaign: { ownerId: user.id }, status: 'PENDING' },
        include: {
          applicant: true,
          campaign: { include: { group: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      return { ok: true, applications };
    } catch (error) {
      return sendRouteError(reply, error, 401);
    }
  });

  app.post<{ Params: { id: string } }>('/applications/:id/approve', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const applicationId = request.params.id;

      const application = await prisma.application.findUnique({
        where: { id: applicationId },
        include: { campaign: true },
      });
      if (!application) return reply.code(404).send({ ok: false, error: 'application not found' });
      if (application.campaign.ownerId !== user.id) {
        return reply.code(403).send({ ok: false, error: 'not owner' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ ok: false, error: 'already reviewed' });
      }

      const result = await prisma.$transaction(async (tx) => {
        const campaign = await tx.campaign.findUnique({ where: { id: application.campaignId } });
        if (!campaign || campaign.status !== 'ACTIVE') throw new Error('campaign paused');
        if (campaign.remainingBudget < campaign.rewardPoints) throw new Error('budget empty');

        await tx.application.update({
          where: { id: applicationId },
          data: { status: 'APPROVED', reviewedAt: new Date() },
        });

        const updatedCampaign = await tx.campaign.update({
          where: { id: campaign.id },
          data: {
            remainingBudget: { decrement: campaign.rewardPoints },
            status:
              campaign.remainingBudget - campaign.rewardPoints <= 0 ? 'COMPLETED' : campaign.status,
          },
        });

        await creditUserForCampaign(tx, {
          userId: application.applicantId,
          campaign,
          reason: campaign.actionType === 'REACTION' ? 'Реакция на пост' : 'Вступление в группу',
        });

        return updatedCampaign;
      });

      return { ok: true, campaign: result };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });

  app.post<{ Params: { id: string } }>('/applications/:id/reject', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const applicationId = request.params.id;

      const application = await prisma.application.findUnique({
        where: { id: applicationId },
        include: { campaign: true },
      });
      if (!application) return reply.code(404).send({ ok: false, error: 'application not found' });
      if (application.campaign.ownerId !== user.id) {
        return reply.code(403).send({ ok: false, error: 'not owner' });
      }

      const updated = await prisma.application.update({
        where: { id: applicationId },
        data: { status: 'REJECTED', reviewedAt: new Date() },
      });

      return { ok: true, application: updated };
    } catch (error) {
      return sendRouteError(reply, error, 400);
    }
  });
};
