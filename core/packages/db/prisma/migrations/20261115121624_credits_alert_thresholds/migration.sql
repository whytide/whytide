-- Hand-written (prisma/schema/credits.prisma points here), for CREDITS_ALERT_THRESHOLDS
-- (env-settings-b; core/modules/credits/README.md "Settings"): a threshold is any whole percent from
-- 1 to 100, the ones the setting names, in place of 80, 95 and 100 alone. Expand only: every row
-- written before holds one of those three, which the new CHECK takes as they are.
ALTER TABLE "credit_alerts" DROP CONSTRAINT "credit_alerts_threshold";
ALTER TABLE "credit_alerts" ADD CONSTRAINT "credit_alerts_threshold"
  CHECK ("threshold" BETWEEN 1 AND 100);
