-- CreateTable
CREATE TABLE "company_documents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "company_knowledge_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "content_hash" TEXT NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "company_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_documents_workspace_id_company_knowledge_id_name_key" ON "company_documents"("workspace_id", "company_knowledge_id", "name");

