-- CreateEnum
CREATE TYPE "person_hash_kind" AS ENUM ('rejected_candidate', 'erased');

-- CreateTable
CREATE TABLE "persons" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "linkedin_url" TEXT NOT NULL,
    "provider_refs" JSONB,
    "first_name" TEXT,
    "last_name" TEXT,
    "headline" TEXT,
    "title" TEXT,
    "company_name" TEXT,
    "company_id" TEXT,
    "location_text" TEXT,
    "location_country" TEXT,
    "field_provenance" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_companies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "linkedin_url" TEXT,
    "industry" TEXT,
    "size_range" TEXT,
    "country" TEXT,
    "provider_refs" JSONB,
    "field_provenance" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workspace_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_hashes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "kind" "person_hash_kind" NOT NULL,
    "drop_reasons" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "person_hashes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "persons_workspace_id_company_id_idx" ON "persons"("workspace_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "persons_workspace_id_linkedin_url_key" ON "persons"("workspace_id", "linkedin_url");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_companies_workspace_id_linkedin_url_key" ON "workspace_companies"("workspace_id", "linkedin_url");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_companies_workspace_id_domain_key" ON "workspace_companies"("workspace_id", "domain");

-- CreateIndex
CREATE INDEX "person_hashes_workspace_id_expires_at_idx" ON "person_hashes"("workspace_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "person_hashes_workspace_id_hash_key" ON "person_hashes"("workspace_id", "hash");

-- AddForeignKey
ALTER TABLE "persons" ADD CONSTRAINT "persons_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "workspace_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written (prisma/schema/contacts.prisma points here): a person's URL is stored normalized and
-- lowercased, so that the unique (workspace_id, linkedin_url) holds whatever the case it arrived in;
-- upsertPersonFromSource normalizes it, and this refuses any other writer that does not.
ALTER TABLE "persons" ADD CONSTRAINT "persons_linkedin_url_lowercase" CHECK ("linkedin_url" = lower("linkedin_url"));

-- An erased person's hash never expires, a rejected candidate's always does (recordHash: 90 days).
ALTER TABLE "person_hashes" ADD CONSTRAINT "person_hashes_expiry" CHECK (("kind" = 'erased') = ("expires_at" IS NULL));
