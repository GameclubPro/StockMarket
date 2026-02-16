import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const force =
  process.argv.includes('--yes') ||
  process.env.ALLOW_DATA_RESET === 'true' ||
  process.env.ALLOW_DB_CLEAR === 'true';

if (!force) {
  console.error(
    'Refusing to clear data. Re-run with --yes or set ALLOW_DATA_RESET=true.'
  );
  process.exit(1);
}

const main = async () => {
  const result = await prisma.$transaction(async (tx) => {
    const ledger = await tx.ledgerEntry.deleteMany();
    const applications = await tx.application.deleteMany();
    const campaignReports = await tx.campaignReport.deleteMany();
    const hiddenCampaigns = await tx.hiddenCampaign.deleteMany();
    const campaigns = await tx.campaign.deleteMany();
    const groupAdmins = await tx.groupAdmin.deleteMany();
    const groups = await tx.group.deleteMany();
    const referralRewards = await tx.referralReward.deleteMany();
    const referrals = await tx.referral.deleteMany();
    const linkCodes = await tx.platformLinkCode.deleteMany();
    const identities = await tx.userIdentity.deleteMany();
    const users = await tx.user.deleteMany();

    return {
      ledger,
      applications,
      campaignReports,
      hiddenCampaigns,
      campaigns,
      groupAdmins,
      groups,
      referralRewards,
      referrals,
      linkCodes,
      identities,
      users,
    };
  });

  console.log('Cleared user data:', {
    ledger: result.ledger.count,
    applications: result.applications.count,
    campaignReports: result.campaignReports.count,
    hiddenCampaigns: result.hiddenCampaigns.count,
    campaigns: result.campaigns.count,
    groupAdmins: result.groupAdmins.count,
    groups: result.groups.count,
    referralRewards: result.referralRewards.count,
    referrals: result.referrals.count,
    linkCodes: result.linkCodes.count,
    identities: result.identities.count,
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
