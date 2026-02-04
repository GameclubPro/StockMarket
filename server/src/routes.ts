import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from './db.js';
import { config } from './config.js';
import { signSession, verifySession } from './auth.js';
import { verifyInitData } from './telegram.js';

const authBodySchema = z.object({
  initData: z.string().min(1),
});

const offerCreateSchema = z.object({
  platform: z.enum(['TELEGRAM', 'YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'X']),
  action: z.enum(['SUBSCRIBE', 'SUBSCRIBE_LIKE', 'LIKE_COMMENT']),
  ratio: z.enum(['ONE_ONE', 'ONE_TWO', 'TWO_ONE']),
  link: z.string().url(),
  note: z.string().max(1200).optional().default(''),
});

const offerQuerySchema = z.object({
  platform: z.enum(['TELEGRAM', 'YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'X']).optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
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
      },
    });

    return user;
  }

  throw new Error('unauthorized');
};

export const registerRoutes = (app: FastifyInstance) => {
  app.get('/health', async () => ({ ok: true }));

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

    return { ok: true, user, token };
  });

  app.get('/offers', async (request, reply) => {
    const parsed = offerQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid query' });

    const { platform, limit } = parsed.data;
    const offers = await prisma.offer.findMany({
      where: platform ? { platform } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit ?? 20,
      include: { user: true },
    });
    return { ok: true, offers };
  });

  app.post('/offers', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const parsed = offerCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid body' });

      const offer = await prisma.offer.create({
        data: {
          userId: user.id,
          platform: parsed.data.platform,
          action: parsed.data.action,
          ratio: parsed.data.ratio,
          link: parsed.data.link,
          note: parsed.data.note ?? '',
        },
      });

      return { ok: true, offer };
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
    }
  });

  app.post('/offers/:id/respond', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const offerId = (request.params as any).id as string;
      const offer = await prisma.offer.findUnique({ where: { id: offerId } });
      if (!offer) return reply.code(404).send({ ok: false, error: 'offer not found' });

      const existing = await prisma.request.findFirst({
        where: { offerId: offer.id, requesterId: user.id },
      });
      if (existing) return { ok: true, request: existing };

      const reqEntry = await prisma.request.create({
        data: {
          offerId: offer.id,
          requesterId: user.id,
        },
      });

      return { ok: true, request: reqEntry };
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
    }
  });

  app.get('/me', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const offers = await prisma.offer.count({ where: { userId: user.id } });
      const requests = await prisma.request.count({ where: { requesterId: user.id } });
      return { ok: true, user, stats: { offers, requests } };
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
    }
  });
};
