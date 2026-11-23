-- AlterTable
ALTER TABLE "workspace_companies" ADD COLUMN     "company_id" TEXT;

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "linkedin_url" TEXT,
    "domain" TEXT,
    "industry" TEXT,
    "size_range" TEXT,
    "country" TEXT,
    "employee_count" INTEGER,
    "description" TEXT,
    "provider_refs" JSONB,
    "field_provenance" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_companies" (
    "sharing_group_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "linkedin_url" TEXT,
    "domain" TEXT,
    "industry" TEXT,
    "size_range" TEXT,
    "country" TEXT,
    "employee_count" INTEGER,
    "description" TEXT,
    "provider_refs" JSONB,
    "field_provenance" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "group_companies_pkey" PRIMARY KEY ("sharing_group_id","company_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_linkedin_url_key" ON "companies"("linkedin_url");

-- CreateIndex
CREATE UNIQUE INDEX "companies_domain_key" ON "companies"("domain");

-- CreateIndex
CREATE INDEX "workspace_companies_workspace_id_company_id_idx" ON "workspace_companies"("workspace_id", "company_id");

-- AddForeignKey
ALTER TABLE "workspace_companies" ADD CONSTRAINT "workspace_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "group_companies" ADD CONSTRAINT "group_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (prisma/schema/contacts.prisma points here; gamma-rf-010): the company index keeps
-- what it learns, so the app reads, inserts and updates its two tables and never deletes.
REVOKE DELETE ON TABLE "companies" FROM app;
REVOKE DELETE ON TABLE "group_companies" FROM app;

-- Hand-written: what every organization reads holds only a shared class's stamps. Each stamp of
-- companies.field_provenance is an object whose source is open_data, website, web_search or
-- data_vendor (contacts' CONTACTS_SHARED_FACT_SOURCES may name no other), so a stamp from linkedin,
-- import, member or ai_inferred, or without a source, is refused whatever the code does. The
-- two-argument jsonb_path_exists is immutable, as a CHECK needs. A shared company is made with one
-- of its keys.
ALTER TABLE "companies" ADD CONSTRAINT "companies_field_provenance_source" CHECK (
    jsonb_typeof("field_provenance") = 'object'
    AND NOT jsonb_path_exists("field_provenance",
      '$.* ? (!(@.source.type() == "string") || !(@.source == "open_data" || @.source == "website" || @.source == "web_search" || @.source == "data_vendor"))')
  ),
  ADD CONSTRAINT "companies_key" CHECK ("linkedin_url" IS NOT NULL OR "domain" IS NOT NULL),
  ADD CONSTRAINT "companies_employee_count" CHECK ("employee_count" IS NULL OR "employee_count" >= 1),
  ADD CONSTRAINT "companies_description" CHECK ("description" IS NULL OR char_length("description") <= 2000);

-- Hand-written: workspace_companies' bounds on a company's own facts, on the group's row too.
ALTER TABLE "group_companies" ADD CONSTRAINT "group_companies_employee_count" CHECK ("employee_count" IS NULL OR "employee_count" >= 1),
  ADD CONSTRAINT "group_companies_description" CHECK ("description" IS NULL OR char_length("description") <= 2000);
