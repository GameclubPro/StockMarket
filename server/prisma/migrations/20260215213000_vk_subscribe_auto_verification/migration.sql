ALTER TABLE `Application`
  ADD COLUMN `verificationChecks` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `lastVerificationAt` DATETIME(3) NULL;

CREATE INDEX `Application_status_lastVerificationAt_idx`
  ON `Application`(`status`, `lastVerificationAt`);

CREATE INDEX `Application_campaignId_applicantId_status_idx`
  ON `Application`(`campaignId`, `applicantId`, `status`);
