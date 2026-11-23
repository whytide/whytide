-- CreateEnum
CREATE TYPE "approval_by" AS ENUM ('person', 'mode');

-- AlterEnum
ALTER TYPE "approval_action_type" ADD VALUE 'email';

-- AlterEnum
ALTER TYPE "approval_decision_origin" ADD VALUE 'approval_mode';

-- AlterTable
ALTER TABLE "approval_items" ADD COLUMN     "approval_by" "approval_by" NOT NULL DEFAULT 'person',
ADD COLUMN     "mailbox_id" TEXT,
ALTER COLUMN "sender_account_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "approval_items_workspace_id_step_execution_id_idx" ON "approval_items"("workspace_id", "step_execution_id");

-- Hand-written (prisma/schema/approvals.prisma points here; gamma-p4-090). The new values are
-- compared as text: Postgres refuses `email` and `approval_mode` inside the transaction that adds
-- them (20261102125800_contacts_suppression_channels does the same).
--
-- An email item goes out from a mailbox and no LinkedIn account; every other item from an account
-- and no mailbox.
ALTER TABLE "approval_items" ADD CONSTRAINT "approval_items_channel_sender" CHECK (
    ("action_type"::text = 'email') = ("mailbox_id" IS NOT NULL)
    AND ("action_type"::text = 'email') = ("sender_account_id" IS NULL)
  );

-- A decision's time and origin exactly on an approved or a skipped item, and its user too unless the
-- campaign's mode approved it; the mode only approves, never skips, and only an item opened for it
-- that is no connection request.
ALTER TABLE "approval_items" DROP CONSTRAINT "approval_items_decision",
  ADD CONSTRAINT "approval_items_decision" CHECK (
    ("status" IN ('approved', 'skipped')) = ("decided_at" IS NOT NULL)
    AND ("status" IN ('approved', 'skipped')) = ("decision_origin" IS NOT NULL)
    AND (
      "status" IN ('approved', 'skipped')
      AND "decision_origin"::text IS DISTINCT FROM 'approval_mode'
    ) = ("decided_by" IS NOT NULL)
    AND (
      "decision_origin"::text IS DISTINCT FROM 'approval_mode'
      OR ("status" = 'approved' AND "approval_by"::text = 'mode' AND "action_type"::text <> 'invite')
    )
  );

-- A wait on an approved item, as before, or the mode's refusal on a pending item opened for it,
-- `mode_declined`, with no time: "Up next" says why a person decides it.
ALTER TABLE "approval_items" DROP CONSTRAINT "approval_items_wait",
  ADD CONSTRAINT "approval_items_wait" CHECK (
    "wait_code" IS NULL
    OR "status" = 'approved'
    OR (
      "status" = 'pending'
      AND "wait_code" = 'mode_declined'
      AND "wait_until" IS NULL
      AND "approval_by"::text = 'mode'
    )
  );
