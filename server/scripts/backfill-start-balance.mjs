import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const run = async () => {
  const result = await prisma.user.updateMany({
    where: {
      balance: 0,
      ledger: { none: {} },
    },
    data: { balance: 30 },
  });

  console.log(`Updated users: ${result.count}`);
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
