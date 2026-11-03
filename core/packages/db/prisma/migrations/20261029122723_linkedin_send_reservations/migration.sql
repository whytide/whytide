-- CreateEnum
CREATE TYPE "sender_action_type" AS ENUM ('read', 'invite', 'message', 'withdraw');

-- AlterEnum
ALTER TYPE "sender_action_kind" ADD VALUE 'invite';
ALTER TYPE "sender_action_kind" ADD VALUE 'message';
ALTER TYPE "sender_action_kind" ADD VALUE 'withdraw';
ALTER TYPE "sender_action_kind" ADD VALUE 'send_check';

-- AlterEnum
ALTER TYPE "sender_quota_reservation_status" ADD VALUE 'committed_late';

-- AlterTable
ALTER TABLE "sender_accounts" ADD COLUMN     "retry_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "sender_action_log" ADD COLUMN     "with_note" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "sender_quota_reservations" ADD COLUMN     "action_type" "sender_action_type" NOT NULL DEFAULT 'read',
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "with_note" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "sender_quota_reservations_workspace_id_idempotency_key_idx" ON "sender_quota_reservations"("workspace_id", "idempotency_key");

-- Hand-written (prisma/schema/linkedin.prisma points here). A day row keeps the zone it was made in
-- (a zone change takes effect from the next local day): the existing rows take their account's zone,
-- and a row whose account is gone, UTC, before the column becomes required.
ALTER TABLE "sender_quota_usage" ADD COLUMN "time_zone" TEXT;
UPDATE "sender_quota_usage" AS "usage" SET "time_zone" = "account"."time_zone"
  FROM "sender_accounts" AS "account"
  WHERE "account"."id" = "usage"."sender_account_id" AND "account"."workspace_id" = "usage"."workspace_id";
UPDATE "sender_quota_usage" SET "time_zone" = 'UTC' WHERE "time_zone" IS NULL;
ALTER TABLE "sender_quota_usage" ALTER COLUMN "time_zone" SET NOT NULL;
-- The previous release inserts a day's row without the column while an upgrade runs (architecture
-- §7.6): the row takes its account's zone, else UTC, as the backfill does. A later release drops the
-- trigger once no running release omits the column.
CREATE FUNCTION linkedin_usage_time_zone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.time_zone := COALESCE(
    (SELECT "time_zone" FROM "sender_accounts"
      WHERE "id" = NEW.sender_account_id AND "workspace_id" = NEW.workspace_id),
    'UTC');
  RETURN NEW;
END
$$;
CREATE TRIGGER "sender_quota_usage_time_zone" BEFORE INSERT ON "sender_quota_usage"
  FOR EACH ROW WHEN (NEW.time_zone IS NULL) EXECUTE FUNCTION linkedin_usage_time_zone();

-- A send's reservation carries its step's key and holds one action; a read's carries no key. One
-- reserved or committed reservation per key and workspace: a released or expired one, and a late
-- commit (committed_late), leave the key to the next.
ALTER TABLE "sender_quota_reservations" ADD CONSTRAINT "sender_quota_reservations_send_key" CHECK (
  CASE WHEN "action_type" = 'read' THEN "idempotency_key" IS NULL
    ELSE "idempotency_key" IS NOT NULL AND "count" = 1 END
);
CREATE UNIQUE INDEX "sender_quota_reservations_live_key" ON "sender_quota_reservations" ("workspace_id", "idempotency_key")
  WHERE "status" IN ('reserved', 'committed');

-- The action log's outcomes, a closed list: ACTION_OUTCOMES in core/modules/linkedin/schemas/quota.ts,
-- which a test keeps equal to this. Every outcome alpha's code wrote is in it.
ALTER TABLE "sender_action_log" ADD CONSTRAINT "sender_action_log_outcome_known" CHECK ("outcome" IN (
  'ok', 'reserved',
  'linkedin_account_disconnected', 'rate_limited', 'outside_working_hours', 'invite_note_budget',
  'invite_cap_reached', 'message_cap_reached', 'withdrawal_cap_reached', 'weekly_invite_cap_reached',
  'daily_actions_cap_reached', 'read_cap_reached',
  'sending_closed', 'platform_stopped', 'workspace_stopped', 'account_stopped', 'account_paused',
  'invites_paused', 'disclosure_required', 'pending_invites_over_limit', 'pending_invites_unknown',
  'reservation_not_open',
  'linkedin_rate_limited', 'linkedin_not_found', 'linkedin_webhook_invalid', 'linkedin_provider_error',
  'linkedin_limit_reached', 'linkedin_send_refused', 'linkedin_input_invalid', 'linkedin_output_invalid',
  'linkedin_error_unmapped',
  'connected', 'disconnected', 'credentials_required', 'error'
));

-- Append-only for app (docs/security.md): it inserts and reads log rows and never updates one; it
-- keeps DELETE for linkedin's erasePerson (beta-p0-060) and the 90-day purge (beta-p1-080), as
-- review_decisions does (20261022210000_contacts_review_decisions).
REVOKE UPDATE ON TABLE "sender_action_log" FROM app;
