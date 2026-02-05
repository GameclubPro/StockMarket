import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from './db.js';
import { type Prisma, type User } from '@prisma/client';
import { config } from './config.js';
import { signSession, verifySession } from './auth.js';
import { verifyInitData } from './telegram.js';
import { ensureBotIsAdmin, extractUsername, getChatMemberStatus, isActiveMemberStatus } from './telegram-bot.js';
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

const PLATFORM_FEE_RATE = 0.3;
const RANKS = [
  { level: 0, minTotal: 0, title: 'Новичок', bonusRate: 0 },
  { level: 1, minTotal: 100, title: 'Бронза', bonusRate: 0.05 },
  { level: 2, minTotal: 300, title: 'Серебро', bonusRate: 0.1 },
  { level: 3, minTotal: 1000, title: 'Золото', bonusRate: 0.15 },
  { level: 4, minTotal: 3000, title: 'Платина', bonusRate: 0.2 },
  { level: 5, minTotal: 5000, title: 'Алмаз', bonusRate: 0.3 },
];

const getRankByTotal = (totalEarned: number) => {
  let current = RANKS[0];
  for (const rank of RANKS) {
    if (totalEarned >= rank.minTotal) current = rank;
  }
  return current;
};

const calculateBasePayout = (rewardPoints: number) => {
  const payout = Math.round(rewardPoints * (1 - PLATFORM_FEE_RATE));
  return Math.max(1, Math.min(rewardPoints, payout));
};

const calculatePayoutWithBonus = (rewardPoints: number, bonusRate: number) => {
  const base = calculateBasePayout(rewardPoints);
  const bonus = Math.round(base * bonusRate);
  return Math.max(1, Math.min(rewardPoints, base + bonus));
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
    if (parts[0] === 'c') return null;
    const username = parts[0];
    const messageId = Number(parts[1]);
    if (!Number.isInteger(messageId) || messageId <= 0) return null;
    return { username, messageId };
  } catch {
    return null;
  }
};

const getToken = (authHeader?: string) => {
  if (!authHeader) return '';
  const [type, token] = authHeader.split(' ');
  if (type?.toLowerCase() !== 'bearer') return '';
  return token ?? '';
};

const getOptionalUser = async (request: any) => {
  const bearer = getToken(request.headers.authorization);
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

  return payout;
};

const applyUnsubscribePenalty = async (
  tx: Prisma.TransactionClient,
  payload: { userId: string; campaignId: string }
) => {
  const [user, earnedEntry] = await Promise.all([
    tx.user.findUnique({ where: { id: payload.userId }, select: { totalEarned: true } }),
    tx.ledgerEntry.findFirst({
      where: { userId: payload.userId, campaignId: payload.campaignId, type: 'EARN' },
      orderBy: { createdAt: 'desc' },
      select: { amount: true },
    }),
  ]);

  if (!user || !earnedEntry) return null;

  const earnedAmount = Math.max(0, Math.abs(earnedEntry.amount));
  if (earnedAmount === 0) return null;

  const penalty = earnedAmount * 2;
  const newTotalEarned = Math.max(0, user.totalEarned - penalty);

  await tx.user.update({
    where: { id: payload.userId },
    data: {
      balance: { decrement: penalty },
      totalEarned: newTotalEarned,
    },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: payload.userId,
      type: 'ADJUST',
      amount: -penalty,
      reason: 'Отписка от группы',
      campaignId: payload.campaignId,
    },
  });

  return penalty;
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

  if (Object.keys(data).length === 0) return user;
  return await prisma.user.update({ where: { id: user.id }, data });
};

const requireUser = async (request: any) => {
  const bearer = getToken(request.headers.authorization);
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

export const registerRoutes = (app: FastifyInstance) => {
  app.get('/health', async () => ({ ok: true }));

  app.post('/telegram/webhook', async (request, reply) => {
    const secret = config.botWebhookSecret;
    const header = request.headers['x-telegram-bot-api-secret-token'];
    if (secret && header !== secret) {
      return reply.code(401).send({ ok: false });
    }

    const update = request.body as TelegramUpdate;
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
          const username = chat.username ?? '';
          const inviteLink = `https://t.me/${username}`;
          const existing = await prisma.group.findFirst({
            where: { ownerId, username },
          });
          if (existing) {
            await prisma.group.update({
              where: { id: existing.id },
              data: {
                title: chat.title ?? existing.title,
                inviteLink,
              },
            });
            return;
          }

          await prisma.group.create({
            data: {
              ownerId,
              title: chat.title ?? username,
              username,
              inviteLink,
              description: null,
              category: null,
            },
          });
        },
        handleReaction: async ({ chat, user, messageId }) => {
          if (!chat.username) return;
          const group = await prisma.group.findFirst({ where: { username: chat.username } });
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
          if (!chat.username) return;
          const group = await prisma.group.findFirst({ where: { username: chat.username } });
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

              if (chat.type !== 'channel') return;
              if (lastCount === null || lastCount === undefined) return;

              const delta = totalCount - lastCount;
              if (delta <= 0) return;

              const maxByBudget = Math.floor(
                freshCampaign.remainingBudget / freshCampaign.rewardPoints
              );
              if (maxByBudget <= 0) return;

              const pending = await tx.application.findMany({
                where: { campaignId: freshCampaign.id, status: 'PENDING' },
                orderBy: { createdAt: 'asc' },
                take: Math.min(delta, maxByBudget),
              });
              if (pending.length === 0) return;

              const approveCount = Math.min(delta, pending.length, maxByBudget);
              const toApprove = pending.slice(0, approveCount);
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
          if (!chat.username) return;
          if (user.is_bot) return;
          const isJoinStatus =
            status === 'member' || status === 'administrator' || status === 'creator';
          const isLeaveStatus = status === 'left' || status === 'kicked';
          if (!isJoinStatus && !isLeaveStatus) return;

          const group = await prisma.group.findFirst({ where: { username: chat.username } });
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
      });
      return reply.send(result);
    } catch {
      return reply.send({ ok: true });
    }
  });

  app.post('/auth/verify', async (request, reply) => {
    const parsed = authBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });

    const authData = verifyInitData(parsed.data.initData, config.botToken, config.maxAuthAgeSec);
    const tgUser = authData.user;
    if (!tgUser) return reply.code(401).send({ ok: false, error: 'no user' });

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

    const ensuredUser = await ensureLegacyStats(user);

    let token = '';
    if (config.appSecret) {
      token = await signSession({
        sub: ensuredUser.id,
        tid: ensuredUser.telegramId,
        username: ensuredUser.username ?? undefined,
      });
    }

    return { ok: true, user: ensuredUser, balance: ensuredUser.balance, token };
  });

  app.get('/me', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const [groups, campaigns, applications] = await Promise.all([
        prisma.group.count({ where: { ownerId: user.id } }),
        prisma.campaign.count({ where: { ownerId: user.id } }),
        prisma.application.count({ where: { applicantId: user.id } }),
      ]);
      return {
        ok: true,
        user,
        balance: user.balance,
        stats: { groups, campaigns, applications },
      };
    } catch (error: any) {
      const message = error?.message ?? 'unauthorized';
      const status =
        message === 'unauthorized' || message === 'user not found' || message === 'no user'
          ? 401
          : error?.status && Number.isFinite(error.status)
            ? error.status
            : 400;
      return reply.code(status).send({ ok: false, error: message });
    }
  });

  app.get('/groups/my', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const groups = await prisma.group.findMany({
        where: { ownerId: user.id },
        orderBy: { createdAt: 'desc' },
      });
      return { ok: true, groups };
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
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

      const group = await prisma.group.create({
        data: {
          ownerId: user.id,
          title: parsed.data.title,
          username: resolvedUsername.replace(/^@/, ''),
          inviteLink: parsed.data.inviteLink,
          description: parsed.data.description,
          category: parsed.data.category,
        },
      });

      return { ok: true, group };
    } catch (error: any) {
      const message = error?.message ?? 'unauthorized';
      const status =
        message === 'unauthorized' || message === 'user not found' || message === 'no user'
          ? 401
          : error?.status && Number.isFinite(error.status)
            ? error.status
            : 400;
      return reply.code(status).send({ ok: false, error: message });
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
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
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

      const group = await prisma.group.findUnique({ where: { id: parsed.data.groupId } });
      if (!group || group.ownerId !== user.id) {
        return reply.code(403).send({ ok: false, error: 'not owner' });
      }

      let targetMessageId: number | null = null;
      if (parsed.data.actionType === 'reaction') {
        if (!parsed.data.targetMessageLink) {
          return reply.code(400).send({
            ok: false,
            error: 'Для реакций нужна ссылка на пост (формат https://t.me/username/123).',
          });
        }
        if (!group.username) {
          return reply.code(400).send({
            ok: false,
            error: 'У группы нет публичного @username для проверки реакций.',
          });
        }
        const parsedLink = parseMessageLink(parsed.data.targetMessageLink);
        if (!parsedLink) {
          return reply.code(400).send({
            ok: false,
            error: 'Ссылка на пост некорректна. Нужен формат https://t.me/username/123.',
          });
        }
        if (parsedLink.username.toLowerCase() !== group.username.toLowerCase()) {
          return reply.code(400).send({
            ok: false,
            error: 'Ссылка на пост должна быть из выбранной группы/канала.',
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
    } catch (error: any) {
      const rawMessage = String(error?.message ?? 'unauthorized');
      const status =
        rawMessage === 'unauthorized' || rawMessage === 'user not found' || rawMessage === 'no user'
          ? 401
          : 400;
      const message = rawMessage === 'insufficient_balance' ? 'Недостаточно баллов.' : rawMessage;
      return reply.code(status).send({ ok: false, error: message });
    }
  });

  app.post('/campaigns/:id/apply', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const campaignId = (request.params as any).id as string;
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        include: { group: true },
      });
      if (!campaign) return reply.code(404).send({ ok: false, error: 'campaign not found' });
      if (campaign.ownerId === user.id) {
        return reply.code(400).send({ ok: false, error: 'cannot apply own campaign' });
      }
      if (campaign.status !== 'ACTIVE' || campaign.remainingBudget < campaign.rewardPoints) {
        return reply.code(400).send({ ok: false, error: 'Задание приостановлено или бюджет исчерпан.' });
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
        existing = await prisma.application.update({
          where: { id: existing.id },
          data: { status: 'PENDING', reviewedAt: null },
        });
      }

      if (campaign.actionType === 'REACTION') {
        if (existing) return { ok: true, application: existing };
        const application = await prisma.application.create({
          data: {
            campaignId,
            applicantId: user.id,
          },
        });
        return { ok: true, application };
      }

      if (!campaign.group.username) {
        return reply
          .code(400)
          .send({ ok: false, error: 'У группы нет публичного @username для проверки.' });
      }

      const telegramId = Number(user.telegramId);
      if (!Number.isFinite(telegramId)) {
        return reply.code(400).send({ ok: false, error: 'Не удалось определить Telegram ID.' });
      }

      const status = await getChatMemberStatus(
        config.botToken,
        campaign.group.username,
        telegramId
      );
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
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
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
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
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
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
    }
  });

  app.post('/applications/:id/approve', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const applicationId = (request.params as any).id as string;

      const application = await prisma.application.findUnique({
        where: { id: applicationId },
        include: { campaign: true },
      });
      if (!application) return reply.code(404).send({ ok: false, error: 'application not found' });
      if (application.campaign.ownerId !== user.id) {
        return reply.code(403).send({ ok: false, error: 'not owner' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(400).send({ ok: false, error: 'already reviewed' });
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
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
    }
  });

  app.post('/applications/:id/reject', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const applicationId = (request.params as any).id as string;

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
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
    }
  });
};
