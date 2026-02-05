import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const run = async () => {
  const totals = await prisma.ledgerEntry.groupBy({
    by: ['userId'],
    where: { type: { in: ['EARN', 'ADJUST'] } },
    _sum: { amount: true },
  });

  let updated = 0;
  for (const entry of totals) {
    const total = Math.max(0, entry._sum.amount ?? 0);
    if (total === 0) continue;
    const result = await prisma.user.updateMany({
      where: { id: entry.userId, totalEarned: 0 },
      data: { totalEarned: total },
    });
    updated += result.count;
  }

  console.log(`Updated users: ${updated}`);
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
