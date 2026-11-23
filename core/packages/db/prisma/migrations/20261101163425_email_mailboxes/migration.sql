-- CreateEnum
CREATE TYPE "mailbox_provider" AS ENUM ('google', 'microsoft');

-- CreateEnum
CREATE TYPE "mailbox_status" AS ENUM ('connected', 'disconnected');

-- CreateEnum
CREATE TYPE "mailbox_disconnected_reason" AS ENUM ('user', 'token_revoked', 'member_removed');

-- CreateTable
CREATE TABLE "sending_domains" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sending_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mailboxes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "sending_domain_id" TEXT NOT NULL,
    "provider" "mailbox_provider" NOT NULL,
    "email_address" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "scopes" TEXT[],
    "oauth_token_ref" BYTEA,
    "is_free_consumer" BOOLEAN NOT NULL,
    "status" "mailbox_status" NOT NULL,
    "disconnected_reason" "mailbox_disconnected_reason",
    "time_zone" TEXT NOT NULL,
    "connected_at" TIMESTAMPTZ NOT NULL,
    "disconnected_at" TIMESTAMPTZ,
    "token_checked_at" TIMESTAMPTZ,

    CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mailbox_connects" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "mailbox_provider" NOT NULL,
    "time_zone" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mailbox_connects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sending_domains_workspace_id_id_key" ON "sending_domains"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sending_domains_workspace_id_domain_key" ON "sending_domains"("workspace_id", "domain");

-- CreateIndex
CREATE INDEX "mailboxes_workspace_id_status_idx" ON "mailboxes"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_workspace_id_email_address_key" ON "mailboxes"("workspace_id", "email_address");

-- CreateIndex
CREATE UNIQUE INDEX "mailbox_connects_workspace_id_state_hash_key" ON "mailbox_connects"("workspace_id", "state_hash");

-- AddForeignKey
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_workspace_id_sending_domain_id_fkey" FOREIGN KEY ("workspace_id", "sending_domain_id") REFERENCES "sending_domains"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (prisma/schema/email.prisma points here; gamma-p1-010): a disconnected mailbox has
-- its reason and its time; a connected one has neither, and holds its tokens.
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_status_columns" CHECK (
    ("status" = 'disconnected') = ("disconnected_reason" IS NOT NULL)
    AND ("status" = 'disconnected') = ("disconnected_at" IS NOT NULL)
    AND ("status" = 'disconnected' OR "oauth_token_ref" IS NOT NULL)
  );

-- Hand-written: one connected mailbox per member and workspace, and one connected mailbox per
-- address across the workspaces, so that one mailbox connected twice cannot double its caps; partial
-- unique indexes, which Prisma's schema cannot say; core/modules/email names both.
CREATE UNIQUE INDEX "mailboxes_owner_connected" ON "mailboxes"("workspace_id", "owner_user_id") WHERE "status" = 'connected';
CREATE UNIQUE INDEX "mailboxes_address_connected" ON "mailboxes"("email_address") WHERE "status" = 'connected';
