-- AlterTable
ALTER TABLE "signal_sources" ADD COLUMN     "import_id" TEXT;

-- CreateTable
CREATE TABLE "signal_source_imports" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "disabled_count" INTEGER NOT NULL DEFAULT 0,
    "refused_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "signal_source_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signal_source_imports_workspace_id_created_at_idx" ON "signal_source_imports"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "signal_source_imports_workspace_id_id_key" ON "signal_source_imports"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "signal_sources" ADD CONSTRAINT "signal_sources_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "signal_source_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
