-- AlterEnum
ALTER TYPE "suppression_match_type" ADD VALUE 'email';

-- AlterTable
ALTER TABLE "suppression_entries" ADD COLUMN     "email" TEXT;

-- CreateTable
CREATE TABLE "person_email_hashes" (
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_email_hashes_pkey" PRIMARY KEY ("workspace_id","hash")
);

-- CreateIndex
CREATE INDEX "person_email_hashes_workspace_id_person_id_idx" ON "person_email_hashes"("workspace_id", "person_id");

-- AddForeignKey
ALTER TABLE "person_email_hashes" ADD CONSTRAINT "person_email_hashes_workspace_id_person_id_fkey" FOREIGN KEY ("workspace_id", "person_id") REFERENCES "persons"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (prisma/schema/contacts.prisma points here; contacts' docs/data.md). An address sits on
-- an email entry only; erasure empties it and keeps the row and its hash. The match type is compared
-- as text: Postgres refuses the value `email` inside the transaction that adds it
-- (20261102125800_contacts_suppression_channels does the same).
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_email_match" CHECK ("email" IS NULL OR "match_type"::text = 'email');

-- An address's hash never moves to another person: app reads, inserts and, for erasure, deletes a
-- row of person_email_hashes, and never updates one.
REVOKE UPDATE ON TABLE "person_email_hashes" FROM app;
