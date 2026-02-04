import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from './db.js';
import { config } from './config.js';
import { signSession, verifySession } from './auth.js';
import { verifyInitData } from './telegram.js';

const DEFAULT_TASKS = [
  {
    slug: 'first_offer',
    title: 'Создай первый оффер',
    description: 'Размести первое предложение в бирже.',
    points: 120,
  },
  {
    slug: 'first_response',
    title: 'Откликнись на оффер',
    description: 'Найди подходящее предложение и откликнись.',
    points: 80,
  },
];

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

const ensureDefaultTasks = async () => {
  await Promise.all(
    DEFAULT_TASKS.map((task) =>
      prisma.task.upsert({
        where: { slug: task.slug },
        update: {
          title: task.title,
          description: task.description,
          points: task.points,
          active: true,
        },
        create: {
          slug: task.slug,
          title: task.title,
          description: task.description,
          points: task.points,
          active: true,
        },
      })
    )
  );
};

const completeTaskBySlug = async (userId: string, slug: string) => {
  const task = await prisma.task.findUnique({ where: { slug } });
  if (!task || !task.active) return null;

  return await prisma.$transaction(async (tx) => {
    const existing = await tx.userTask.findUnique({
      where: { userId_taskId: { userId, taskId: task.id } },
    });
    if (existing?.status === 'COMPLETED') {
      return { task, pointsAdded: 0 };
    }

    await tx.userTask.upsert({
      where: { userId_taskId: { userId, taskId: task.id } },
      update: { status: 'COMPLETED', completedAt: new Date() },
      create: { userId, taskId: task.id, status: 'COMPLETED', completedAt: new Date() },
    });

    await tx.user.update({
      where: { id: userId },
      data: { points: { increment: task.points } },
    });

    return { task, pointsAdded: task.points };
  });
};

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

      await ensureDefaultTasks();
      await completeTaskBySlug(user.id, 'first_offer');

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

      await ensureDefaultTasks();
      await completeTaskBySlug(user.id, 'first_response');

      return { ok: true, request: reqEntry };
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
    }
  });

  app.get('/tasks', async (request, reply) => {
    try {
      await ensureDefaultTasks();
      const user = await requireUser(request);

      const tasks = await prisma.task.findMany({
        where: { active: true },
        orderBy: { createdAt: 'asc' },
      });
      const userTasks = await prisma.userTask.findMany({
        where: { userId: user.id },
      });
      const completed = new Set(
        userTasks.filter((item) => item.status === 'COMPLETED').map((item) => item.taskId)
      );

      return {
        ok: true,
        points: user.points,
        tasks: tasks.map((task) => ({
          id: task.id,
          slug: task.slug,
          title: task.title,
          description: task.description,
          points: task.points,
          completed: completed.has(task.id),
        })),
      };
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
    }
  });

  app.get('/me', async (request, reply) => {
    try {
      const user = await requireUser(request);
      const offers = await prisma.offer.count({ where: { userId: user.id } });
      const requests = await prisma.request.count({ where: { requesterId: user.id } });
      return { ok: true, user, stats: { offers, requests }, points: user.points };
    } catch (error: any) {
      return reply.code(401).send({ ok: false, error: error?.message ?? 'unauthorized' });
    }
  });
};
