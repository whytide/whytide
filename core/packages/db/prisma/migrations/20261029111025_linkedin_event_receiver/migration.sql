-- CreateTable
CREATE TABLE "sender_outreach" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "sender_account_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "provider_member_ref" TEXT,
    "provider_chat_ref" TEXT,
    "provider_invitation_ref" TEXT,
    "invited_at" TIMESTAMPTZ,
    "accepted_at" TIMESTAMPTZ,
    "accepted_detected_at" TIMESTAMPTZ,
    "withdrawn_at" TIMESTAMPTZ,
    "last_sent_at" TIMESTAMPTZ,
    "last_inbound_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sender_outreach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_event_receipts" (
    "id" TEXT NOT NULL,
    "event_key_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "linkedin_event_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sender_outreach_workspace_id_sender_account_id_provider_mem_idx" ON "sender_outreach"("workspace_id", "sender_account_id", "provider_member_ref");

-- CreateIndex
CREATE INDEX "sender_outreach_workspace_id_sender_account_id_provider_cha_idx" ON "sender_outreach"("workspace_id", "sender_account_id", "provider_chat_ref");

-- CreateIndex
CREATE UNIQUE INDEX "sender_outreach_workspace_id_sender_account_id_person_id_key" ON "sender_outreach"("workspace_id", "sender_account_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "linkedin_event_receipts_event_key_hash_key" ON "linkedin_event_receipts"("event_key_hash");

-- Hand-written (prisma/schema/linkedin.prisma points here): a receipt is a kept person event's, of
-- the port's two person kinds; app selects, inserts and deletes receipts (beta-p1-080's purge) and
-- never changes one, so a receipt stays what the run that kept its event wrote.
ALTER TABLE "linkedin_event_receipts" ADD CONSTRAINT "linkedin_event_receipts_kind" CHECK ("kind" IN ('invite.accepted', 'message.received'));
REVOKE UPDATE ON TABLE "linkedin_event_receipts" FROM app;
