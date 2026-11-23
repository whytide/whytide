-- AlterTable
ALTER TABLE "enrollments" ADD COLUMN     "cool_down_until" TIMESTAMPTZ,
ADD COLUMN     "remind_at" TIMESTAMPTZ,
ADD COLUMN     "remind_user_id" TEXT,
ADD COLUMN     "reminded_at" TIMESTAMPTZ,
ADD COLUMN     "reply_label" TEXT,
ADD COLUMN     "reply_label_at" TIMESTAMPTZ,
ADD COLUMN     "resumed_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "enrollments_workspace_id_remind_at_idx" ON "enrollments"("workspace_id", "remind_at");

-- Hand-written (campaigns' docs/data.md). A reply label is one of domain/replies/constants.ts
-- REPLY_ACTION_LABELS and carries its reply's instant; a reminder names its instant and its user
-- together, and is marked sent only when it was set.
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_reply_label" CHECK (
  ("reply_label" IS NULL OR "reply_label" IN ('interested', 'not_now', 'not_interested', 'out_of_office', 'opt_out', 'bounce', 'other'))
  AND ("reply_label" IS NULL) = ("reply_label_at" IS NULL)
);
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_remind" CHECK (
  ("remind_at" IS NULL) = ("remind_user_id" IS NULL)
  AND ("reminded_at" IS NULL OR "remind_at" IS NOT NULL)
);
