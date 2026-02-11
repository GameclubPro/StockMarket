import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const force =
  process.argv.includes('--yes') ||
  process.env.ALLOW_DB_CLEAR === 'true' ||
  process.env.ALLOW_DATA_RESET === 'true';

if (!force) {
  console.error(
    'Refusing to clear database. Re-run with --yes or set ALLOW_DB_CLEAR=true.'
  );
  process.exit(1);
}

const run = async () => {
  const result = await prisma.$transaction(async (tx) => {
    const ledgerEntries = await tx.ledgerEntry.deleteMany();
    const applications = await tx.application.deleteMany();
    const campaigns = await tx.campaign.deleteMany();
    const groupAdmins = await tx.groupAdmin.deleteMany();
    const referralRewards = await tx.referralReward.deleteMany();
    const referrals = await tx.referral.deleteMany();
    const groups = await tx.group.deleteMany();
    const botPanelAccess = await tx.botPanelAccess.deleteMany();
    const users = await tx.user.deleteMany();

    return {
      ledgerEntries: ledgerEntries.count,
      applications: applications.count,
      campaigns: campaigns.count,
      groupAdmins: groupAdmins.count,
      referralRewards: referralRewards.count,
      referrals: referrals.count,
      groups: groups.count,
      botPanelAccess: botPanelAccess.count,
      users: users.count,
    };
  });

  console.log('Database cleared:', result);
};

run()
  .catch((error) => {
    console.error('Failed to clear database:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
