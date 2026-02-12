-- Add moderation block fields to User
ALTER TABLE `User`
  ADD COLUMN `isBlocked` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `blockedAt` DATETIME(3) NULL,
  ADD COLUMN `blockedUntil` DATETIME(3) NULL,
  ADD COLUMN `blockReason` VARCHAR(191) NULL;
