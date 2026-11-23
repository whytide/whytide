-- CreateEnum
CREATE TYPE "signal_found_company_verdict" AS ENUM ('fit', 'not_fit', 'unsure');

-- CreateTable
CREATE TABLE "signal_found_companies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source_id" TEXT,
    "source_label" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "verdict" "signal_found_company_verdict" NOT NULL,
    "reasons" JSONB NOT NULL,
    "country" TEXT,
    "town" TEXT,
    "state" TEXT,
    "one_person" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT,
    "phones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "postal_address" TEXT,
    "page_url" TEXT NOT NULL,
    "place_id" TEXT,
    "company_id" TEXT,
    "member_mark" TEXT,
    "judged_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_found_companies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signal_found_companies_workspace_id_id_key" ON "signal_found_companies"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_found_companies_workspace_id_source_id_domain_key" ON "signal_found_companies"("workspace_id", "source_id", "domain");

-- CreateIndex
CREATE INDEX "signal_found_companies_workspace_id_source_id_verdict_judge_idx" ON "signal_found_companies"("workspace_id", "source_id", "verdict", "judged_at" DESC);

-- AddForeignKey
ALTER TABLE "signal_found_companies" ADD CONSTRAINT "signal_found_companies_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "signal_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
