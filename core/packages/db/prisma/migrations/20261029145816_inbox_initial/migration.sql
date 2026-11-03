-- CreateEnum
CREATE TYPE "inbox_channel" AS ENUM ('linkedin');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "message_sent_by" AS ENUM ('campaign', 'user');

-- CreateTable
CREATE TABLE "threads" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel" "inbox_channel" NOT NULL,
    "sender_account_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "provider_thread_ref" TEXT NOT NULL,
    "last_message_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "direction" "message_direction" NOT NULL,
    "sent_by" "message_sent_by",
    "step_execution_id" TEXT,
    "body" TEXT NOT NULL,
    "provider_message_ref" TEXT,
    "sent_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ,
    "opt_out_matched" BOOLEAN NOT NULL DEFAULT false,
    "owner_notified_at" TIMESTAMPTZ,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "threads_workspace_id_last_message_at_idx" ON "threads"("workspace_id", "last_message_at");

-- CreateIndex
CREATE INDEX "threads_workspace_id_person_id_idx" ON "threads"("workspace_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "threads_workspace_id_id_key" ON "threads"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "threads_workspace_id_channel_provider_thread_ref_key" ON "threads"("workspace_id", "channel", "provider_thread_ref");

-- CreateIndex
CREATE INDEX "messages_workspace_id_thread_id_sent_at_idx" ON "messages"("workspace_id", "thread_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_workspace_id_provider_message_ref_key" ON "messages"("workspace_id", "provider_message_ref");

-- CreateIndex
CREATE UNIQUE INDEX "messages_workspace_id_step_execution_id_key" ON "messages"("workspace_id", "step_execution_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_thread_id_fkey" FOREIGN KEY ("workspace_id", "thread_id") REFERENCES "threads"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (prisma/schema/inbox.prisma points here): sent_by says who sent an outbound message,
-- the platform's campaign or the user; an inbound message, the person's, has none.
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by" CHECK (("sent_by" IS NULL) = ("direction" = 'in'));

-- Grants and policy as alpha's tenant tables (20261022150500_contacts_initial): the owner's default
-- privileges give app SELECT, INSERT, UPDATE and DELETE (20261021000000_db_roles), which the store,
-- the reply mail's marker (beta-p5-030) and the erasure need; no row-level policy before zeta
-- (docs/rules/security.md §3).
