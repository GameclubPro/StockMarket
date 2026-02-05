import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const main = async () => {
  const result = await prisma.$transaction(async (tx) => {
    const ledger = await tx.ledgerEntry.deleteMany();
    const applications = await tx.application.deleteMany();
    const campaigns = await tx.campaign.deleteMany();
    const groups = await tx.group.deleteMany();
    const users = await tx.user.deleteMany();

    return { ledger, applications, campaigns, groups, users };
  });

  console.log('Cleared user data:', {
    ledger: result.ledger.count,
    applications: result.applications.count,
    campaigns: result.campaigns.count,
    groups: result.groups.count,
    users: result.users.count,
  });
};

main()
  .catch((error) => {
    console.error('Failed to clear user data:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
