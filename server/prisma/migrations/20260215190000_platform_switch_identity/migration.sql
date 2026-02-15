-- Add platform dimension to groups and campaigns
ALTER TABLE `Group`
  ADD COLUMN `platform` ENUM('TELEGRAM', 'VK') NOT NULL DEFAULT 'TELEGRAM';

ALTER TABLE `Campaign`
  ADD COLUMN `platform` ENUM('TELEGRAM', 'VK') NOT NULL DEFAULT 'TELEGRAM';

CREATE INDEX `Group_platform_createdAt_idx` ON `Group`(`platform`, `createdAt`);
CREATE INDEX `Campaign_platform_status_remainingBudget_createdAt_idx`
  ON `Campaign`(`platform`, `status`, `remainingBudget`, `createdAt`);

-- Store multiple platform identities for one user
CREATE TABLE `UserIdentity` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `platform` ENUM('TELEGRAM', 'VK') NOT NULL,
  `externalId` VARCHAR(191) NOT NULL,
  `username` VARCHAR(191) NULL,
  `firstName` VARCHAR(191) NULL,
  `lastName` VARCHAR(191) NULL,
  `photoUrl` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `UserIdentity_platform_externalId_key`(`platform`, `externalId`),
  UNIQUE INDEX `UserIdentity_userId_platform_key`(`userId`, `platform`),
  INDEX `UserIdentity_userId_createdAt_idx`(`userId`, `createdAt`),
  CONSTRAINT `UserIdentity_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One-time codes to jump between platforms and keep one account
CREATE TABLE `PlatformLinkCode` (
  `id` VARCHAR(191) NOT NULL,
  `code` VARCHAR(191) NOT NULL,
  `sourceUserId` VARCHAR(191) NOT NULL,
  `targetPlatform` ENUM('TELEGRAM', 'VK') NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `consumedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `PlatformLinkCode_code_key`(`code`),
  INDEX `PlatformLinkCode_sourceUserId_createdAt_idx`(`sourceUserId`, `createdAt`),
  INDEX `PlatformLinkCode_targetPlatform_expiresAt_idx`(`targetPlatform`, `expiresAt`),
  CONSTRAINT `PlatformLinkCode_sourceUserId_fkey`
    FOREIGN KEY (`sourceUserId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Backfill existing users into identity table
INSERT INTO `UserIdentity` (
  `id`,
  `userId`,
  `platform`,
  `externalId`,
  `username`,
  `firstName`,
  `lastName`,
  `photoUrl`,
  `createdAt`,
  `updatedAt`
)
SELECT
  REPLACE(UUID(), '-', ''),
  `u`.`id`,
  CASE
    WHEN `u`.`telegramId` LIKE 'vk:%' THEN 'VK'
    ELSE 'TELEGRAM'
  END,
  CASE
    WHEN `u`.`telegramId` LIKE 'vk:%' THEN SUBSTRING(`u`.`telegramId`, 4)
    ELSE `u`.`telegramId`
  END,
  `u`.`username`,
  `u`.`firstName`,
  `u`.`lastName`,
  `u`.`photoUrl`,
  NOW(3),
  NOW(3)
FROM `User` `u`
WHERE NOT EXISTS (
  SELECT 1
  FROM `UserIdentity` `ui`
  WHERE `ui`.`userId` = `u`.`id`
);
