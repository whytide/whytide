-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "membership_role" NOT NULL DEFAULT 'Owner',
    "invited_by" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMPTZ,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invites_email_idx" ON "invites"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invites_workspace_id_email_key" ON "invites"("workspace_id", "email");

-- Hand-written (prisma/schema/identity.prisma points here): every email lowercased, so that the unique
-- (workspace_id, email) holds whatever the case an address was typed in; createInvite lowercases,
-- and this refuses any other writer that does not.
ALTER TABLE "invites" ADD CONSTRAINT "invites_email_lowercase" CHECK ("email" = lower("email"));
