-- AlterTable
ALTER TABLE "company_knowledge" ADD COLUMN     "draft_run_id" TEXT;

-- CreateTable
CREATE TABLE "website_pages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "company_knowledge_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL DEFAULT '',
    "content_hash" TEXT NOT NULL,

    CONSTRAINT "website_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "website_pages_workspace_id_company_knowledge_id_url_key" ON "website_pages"("workspace_id", "company_knowledge_id", "url");
