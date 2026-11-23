-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "enrichment_hold_until" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "workspace_companies" ADD COLUMN     "description" TEXT,
ADD COLUMN     "employee_count" INTEGER;

-- Hand-written (prisma/schema/contacts.prisma points here; gamma-en-040): the held leads, which
-- enrichment reads oldest first and qualification's selection leaves out; a partial index, which
-- Prisma's schema cannot say. Leads created before this migration are not held.
CREATE INDEX "leads_workspace_id_enrichment_hold_until_idx" ON "leads"("workspace_id", "enrichment_hold_until") WHERE "enrichment_hold_until" IS NOT NULL;

-- Hand-written: a company's own facts, as a source gives them; contacts' domain/rules.ts checks the
-- same bounds before a write.
ALTER TABLE "workspace_companies" ADD CONSTRAINT "workspace_companies_employee_count" CHECK ("employee_count" IS NULL OR "employee_count" >= 1),
  ADD CONSTRAINT "workspace_companies_description" CHECK ("description" IS NULL OR char_length("description") <= 2000);
