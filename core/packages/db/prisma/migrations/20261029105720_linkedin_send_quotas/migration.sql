-- AlterTable
ALTER TABLE "sender_accounts" ADD COLUMN     "invite_target" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "message_target" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "ramp_updated_on" TEXT;

-- AlterTable
ALTER TABLE "sender_quota_usage" ADD COLUMN     "check_after" TIMESTAMPTZ,
ADD COLUMN     "checked_at" TIMESTAMPTZ,
ADD COLUMN     "invite_limit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "invites_committed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "invites_reserved" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "message_limit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "messages_committed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "messages_reserved" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "read_allowance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "withdrawals_committed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "withdrawals_reserved" INTEGER NOT NULL DEFAULT 0;

-- Hand-written (prisma/schema/linkedin.prisma points here): the hard maximums of
-- core/modules/linkedin/domain/quota/constants.ts, which no setting, route or script raises, and the
-- targets' bounds. Every read cap above 100 comes down to 100 first; existing usage rows keep send
-- limits of 0 and take their account's read cap, at most 100, as the day's read allowance. The
-- counters carry no CHECK against the limits: a send that went out is always counted.
UPDATE "sender_accounts" SET "daily_read_cap" = 100 WHERE "daily_read_cap" > 100;
UPDATE "sender_quota_usage" AS "usage" SET "read_allowance" = LEAST("account"."daily_read_cap", 100)
  FROM "sender_accounts" AS "account"
  WHERE "account"."id" = "usage"."sender_account_id" AND "account"."workspace_id" = "usage"."workspace_id";
ALTER TABLE "sender_accounts" ADD CONSTRAINT "sender_accounts_daily_read_cap_range" CHECK ("daily_read_cap" BETWEEN 1 AND 100),
  ADD CONSTRAINT "sender_accounts_invite_target_range" CHECK ("invite_target" BETWEEN 5 AND 15),
  ADD CONSTRAINT "sender_accounts_message_target_range" CHECK ("message_target" BETWEEN 10 AND 40),
  ADD CONSTRAINT "sender_accounts_ramp_updated_on_date" CHECK ("ramp_updated_on" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
-- The day's limits: connection requests at most 25, messages 80, reads 100, and the three together
-- at most the 200 actions a day less the 15 withdrawals (185).
ALTER TABLE "sender_quota_usage" ADD CONSTRAINT "sender_quota_usage_sends_non_negative" CHECK (
    "invites_reserved" >= 0 AND "invites_committed" >= 0 AND "messages_reserved" >= 0
    AND "messages_committed" >= 0 AND "withdrawals_reserved" >= 0 AND "withdrawals_committed" >= 0
  ),
  ADD CONSTRAINT "sender_quota_usage_invite_limit_range" CHECK ("invite_limit" BETWEEN 0 AND 25),
  ADD CONSTRAINT "sender_quota_usage_message_limit_range" CHECK ("message_limit" BETWEEN 0 AND 80),
  ADD CONSTRAINT "sender_quota_usage_read_allowance_range" CHECK ("read_allowance" BETWEEN 0 AND 100),
  ADD CONSTRAINT "sender_quota_usage_limits_within_actions" CHECK ("invite_limit" + "message_limit" + "read_allowance" <= 185);
