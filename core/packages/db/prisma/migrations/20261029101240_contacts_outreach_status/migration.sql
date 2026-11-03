-- CreateEnum
CREATE TYPE "lead_outreach_status" AS ENUM ('pending_review', 'approved', 'in_campaign', 'replied', 'finished', 'suppressed');

-- CreateEnum
CREATE TYPE "lead_status_actor" AS ENUM ('user', 'system');

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "outreach_reason" TEXT,
ADD COLUMN     "outreach_status" "lead_outreach_status" NOT NULL DEFAULT 'pending_review';

-- CreateTable
CREATE TABLE "lead_status_changes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "from_status" "lead_outreach_status" NOT NULL,
    "to_status" "lead_outreach_status" NOT NULL,
    "template_id" TEXT,
    "reason" TEXT,
    "actor_type" "lead_status_actor" NOT NULL,
    "actor_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_status_changes_workspace_id_person_id_created_at_idx" ON "lead_status_changes"("workspace_id", "person_id", "created_at");

-- CreateIndex
CREATE INDEX "leads_workspace_id_outreach_status_idx" ON "leads"("workspace_id", "outreach_status");

-- AddForeignKey
ALTER TABLE "lead_status_changes" ADD CONSTRAINT "lead_status_changes_workspace_id_person_id_fkey" FOREIGN KEY ("workspace_id", "person_id") REFERENCES "leads"("workspace_id", "person_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A user's change names the user; a system change names none.
ALTER TABLE "lead_status_changes" ADD CONSTRAINT "lead_status_changes_actor" CHECK (("actor_type" = 'user') = ("actor_id" IS NOT NULL));

-- A row records a change: recordLeadStatus writes nothing when the status is already the target.
ALTER TABLE "lead_status_changes" ADD CONSTRAINT "lead_status_changes_change" CHECK ("from_status" <> "to_status");

-- Append-only (contacts' docs/data.md): app inserts and reads changes and never updates one; it keeps
-- DELETE for contacts' erasePerson, the one path that removes a person's changes.
REVOKE UPDATE ON TABLE "lead_status_changes" FROM app;

-- Grants and policy as contacts' other tables (20261022150500_contacts_initial): the owner's default
-- privileges give app SELECT, INSERT, UPDATE and DELETE (20261021000000_db_roles), less the UPDATE
-- above; no row-level policy before zeta (docs/rules/security.md §3).
