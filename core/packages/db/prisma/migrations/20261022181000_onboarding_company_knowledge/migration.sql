-- CreateTable
CREATE TABLE "company_knowledge" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source_url" TEXT,
    "fetch_status" TEXT NOT NULL DEFAULT 'none',
    "fetched_at" TIMESTAMPTZ,
    "fetch_error" TEXT,
    "one_liner" TEXT NOT NULL DEFAULT '',
    "long_description" TEXT NOT NULL DEFAULT '',
    "products" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pain_points" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "features_benefits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "proof_points" JSONB NOT NULL DEFAULT '[]',
    "competitors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tone" TEXT NOT NULL DEFAULT '',
    "field_sources" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_knowledge_workspace_id_key" ON "company_knowledge"("workspace_id");

