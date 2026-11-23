-- CreateTable
CREATE TABLE "reply_classifications" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "is_suggested" BOOLEAN NOT NULL,
    "opt_out_detected" BOOLEAN NOT NULL,
    "entities" JSONB NOT NULL,
    "origin" TEXT NOT NULL,
    "decision_record_id" TEXT,
    "model_id" TEXT,
    "prompt_version" INTEGER,
    "actions_taken" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reply_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reply_classifications_workspace_id_person_id_created_at_idx" ON "reply_classifications"("workspace_id", "person_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reply_classifications_workspace_id_message_id_key" ON "reply_classifications"("workspace_id", "message_id");

-- AddForeignKey
ALTER TABLE "reply_classifications" ADD CONSTRAINT "reply_classifications_workspace_id_message_id_fkey" FOREIGN KEY ("workspace_id", "message_id") REFERENCES "messages"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written (schema/inbox.prisma's header). The label is one of the 7 gamma writes (campaigns'
-- REPLY_ACTION_LABELS) or of the 15 of RB-13.2.1, 20 values as not_now and not_interested are in
-- both; the confidence is from 0 to 1; the origin is the phrase, the model or the fallback; a model's
-- row names its call.
ALTER TABLE "reply_classifications" ADD CONSTRAINT "reply_classifications_values" CHECK (
  "label" IN ('interested', 'not_now', 'not_interested', 'out_of_office', 'opt_out', 'bounce', 'other',
    'interested_meeting', 'interested_info', 'question', 'objection_price', 'objection_timing',
    'objection_competitor', 'objection_no_need', 'referral', 'unsubscribe', 'ooo_autoreply',
    'bounce_system', 'neutral_social', 'hostile_or_spam_complaint')
  AND "confidence" >= 0 AND "confidence" <= 1
  AND "origin" IN ('phrase', 'model', 'fallback')
  AND ("origin" <> 'model' OR ("decision_record_id" IS NOT NULL AND "model_id" IS NOT NULL
    AND "prompt_version" IS NOT NULL))
);

-- Grants and policy as inbox_initial's tables: the owner's default privileges give app SELECT,
-- INSERT, UPDATE and DELETE (20261021000000_db_roles), which the classifier's insert and the
-- erasure's cascade need; no row-level policy before zeta (docs/rules/security.md §3).
