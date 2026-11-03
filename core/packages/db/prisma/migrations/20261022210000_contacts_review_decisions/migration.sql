-- CreateEnum
CREATE TYPE "review_decision" AS ENUM ('good_lead', 'not_a_fit');

-- CreateEnum
CREATE TYPE "review_reason_code" AS ENUM ('company_competitor', 'company_wrong_industry_or_type', 'company_wrong_size', 'company_wrong_location', 'contact_wrong_title_or_function', 'contact_wrong_seniority', 'contact_known_or_duplicate', 'data_incorrect_or_outdated', 'signal_not_relevant', 'other', 'company_existing_customer', 'company_in_open_deal', 'contact_not_decision_maker', 'contact_left_company', 'bad_timing');

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "review_status" "review_decision",
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "review_decisions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "decision" "review_decision" NOT NULL,
    "reason_code" "review_reason_code",
    "reason_text" TEXT,
    "good_reason_text" TEXT,
    "snapshot_id" TEXT,
    "fit_at_decision" INTEGER,
    "tier_at_decision" "lead_tier",
    "decided_by" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_decisions_workspace_id_person_id_decided_at_idx" ON "review_decisions"("workspace_id", "person_id", "decided_at");

-- CreateIndex
CREATE INDEX "review_decisions_workspace_id_decided_at_idx" ON "review_decisions"("workspace_id", "decided_at");

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_workspace_id_person_id_fkey" FOREIGN KEY ("workspace_id", "person_id") REFERENCES "leads"("workspace_id", "person_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Append-only (contacts' docs/data.md): app inserts and reads decisions and never updates one; it
-- keeps DELETE for contacts' erasePerson, the one path that removes a person's decisions.
REVOKE UPDATE ON TABLE "review_decisions" FROM app;
