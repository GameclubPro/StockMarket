import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from './db.js';
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
});

const campaignQuerySchema = z.object({
  category: z.string().max(50).optional(),
  actionType: z.enum(['subscribe', 'reaction']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const getToken = (authHeader?: string) => {
  if (!authHeader) return '';
  const [type, token] = authHeader.split(' ');
  if (type?.toLowerCase() !== 'bearer') return '';
  return token ?? '';
};

const requireUser = async (request: any) => {
  const bearer = getToken(request.headers.authorization);
  if (bearer) {
    const payload = await verifySession(bearer);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new Error('user not found');
    return user;
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
        rating: 0,
      },
    });

    return user;
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
      const result = await handleBotWebhookUpdate(update, {
        upsertUser: async (user) => {
          return prisma.user.upsert({
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
              rating: 0,
            },
          });
        },
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
        rating: 0,
      },
    });

    let token = '';
    if (config.appSecret) {
      token = await signSession({
        sub: user.id,
        tid: user.telegramId,
        username: user.username ?? undefined,
      });
    }

    return { ok: true, user, balance: user.balance, token };
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
    const campaigns = await prisma.campaign.findMany({
      where: {
        status: 'ACTIVE',
        remainingBudget: { gt: 0 },
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
      const message =
        error?.message === 'insufficient_balance' ? 'Недостаточно баллов.' : 'unauthorized';
      const status =
        message === 'unauthorized' || message === 'user not found' || message === 'no user'
          ? 401
          : 400;
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

      const existing = await prisma.application.findUnique({
        where: { campaignId_applicantId: { campaignId, applicantId: user.id } },
      });
      if (existing?.status === 'APPROVED') {
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        return { ok: true, application: existing, balance: updatedUser?.balance ?? user.balance };
      }
      if (existing?.status === 'REJECTED') {
        return reply.code(400).send({ ok: false, error: 'Заявка отклонена.' });
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

      const status = await getChatMemberStatus(config.botToken, campaign.group.username, telegramId);
      if (!isActiveMemberStatus(status)) {
        return reply
          .code(400)
          .send({ ok: false, error: 'Сначала вступите в группу, затем нажмите "Проверить".' });
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

        await tx.user.update({
          where: { id: user.id },
          data: { balance: { increment: freshCampaign.rewardPoints } },
        });

        await tx.ledgerEntry.create({
          data: {
            userId: user.id,
            type: 'EARN',
            amount: freshCampaign.rewardPoints,
            reason: 'Вступление в группу',
            campaignId: freshCampaign.id,
          },
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

        await tx.user.update({
          where: { id: application.applicantId },
          data: { balance: { increment: campaign.rewardPoints } },
        });

        await tx.ledgerEntry.create({
          data: {
            userId: application.applicantId,
            type: 'EARN',
            amount: campaign.rewardPoints,
            reason: campaign.actionType === 'REACTION' ? 'Реакция на пост' : 'Вступление в группу',
            campaignId: campaign.id,
          },
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
