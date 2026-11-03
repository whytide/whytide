-- AlterTable
ALTER TABLE "sender_accounts" ADD COLUMN     "disclosure_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "member_id_checked_at" TIMESTAMPTZ,
ADD COLUMN     "member_id_hash" TEXT,
ADD COLUMN     "personal_account_confirmed_at" TIMESTAMPTZ;

-- Hand-written (prisma/schema/linkedin.prisma points here). Every existing account keeps alpha's
-- disclosure, version 1, which covers reads only: it sends once its owner accepts DISCLOSURE_VERSION.
ALTER TABLE "sender_accounts" ADD CONSTRAINT "sender_accounts_disclosure_version" CHECK ("disclosure_version" >= 1);

-- One LinkedIn account on one connected row, across every workspace: a second connected row with the
-- same member id's hash is refused, and the refresh then ends that row (domain/disclosure/member.ts).
CREATE UNIQUE INDEX "sender_accounts_member_id_hash_connected" ON "sender_accounts" ("member_id_hash")
  WHERE "status" = 'connected' AND "member_id_hash" IS NOT NULL;

-- The action log's outcomes: ACTION_OUTCOMES (schemas/quota.ts) gains member_id_unknown, a send's
-- refusal, and sender_account_in_use, a status check's.
ALTER TABLE "sender_action_log" DROP CONSTRAINT "sender_action_log_outcome_known";
ALTER TABLE "sender_action_log" ADD CONSTRAINT "sender_action_log_outcome_known" CHECK ("outcome" IN (
  'ok', 'reserved',
  'linkedin_account_disconnected', 'rate_limited', 'outside_working_hours', 'invite_note_budget',
  'invite_cap_reached', 'message_cap_reached', 'withdrawal_cap_reached', 'weekly_invite_cap_reached',
  'daily_actions_cap_reached', 'read_cap_reached',
  'sending_closed', 'platform_stopped', 'workspace_stopped', 'account_stopped', 'account_paused',
  'invites_paused', 'disclosure_required', 'member_id_unknown', 'pending_invites_over_limit',
  'pending_invites_unknown', 'reservation_not_open',
  'linkedin_rate_limited', 'linkedin_not_found', 'linkedin_webhook_invalid', 'linkedin_provider_error',
  'linkedin_limit_reached', 'linkedin_send_refused', 'linkedin_input_invalid', 'linkedin_output_invalid',
  'linkedin_error_unmapped',
  'connected', 'disconnected', 'credentials_required', 'error', 'sender_account_in_use'
));
