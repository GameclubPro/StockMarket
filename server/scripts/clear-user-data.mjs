import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const force = process.env.ALLOW_DATA_RESET === 'true' || process.argv.includes('--yes');

if (!force) {
  console.error(
    'Refusing to clear data. Re-run with ALLOW_DATA_RESET=true or pass --yes to confirm.'
  );
  process.exit(1);
}

const main = async () => {
  const result = await prisma.$transaction(async (tx) => {
    const ledger = await tx.ledgerEntry.deleteMany();
    const applications = await tx.application.deleteMany();
    const campaigns = await tx.campaign.deleteMany();
    const groupAdmins = await tx.groupAdmin.deleteMany();
    const groups = await tx.group.deleteMany();
    const users = await tx.user.deleteMany();

    return { ledger, applications, campaigns, groupAdmins, groups, users };
  });

  console.log('Cleared user data:', {
    ledger: result.ledger.count,
    applications: result.applications.count,
    campaigns: result.campaigns.count,
    groupAdmins: result.groupAdmins.count,
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
