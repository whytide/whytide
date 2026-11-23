-- AlterEnum
ALTER TYPE "suppression_source" ADD VALUE 'csv';

-- AlterTable
ALTER TABLE "suppression_entries" ADD COLUMN     "exclusion_list_id" TEXT;

-- CreateTable
CREATE TABLE "exclusion_lists" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" "suppression_relationship" NOT NULL,
    "entry_count" INTEGER NOT NULL,
    "duplicate_count" INTEGER NOT NULL,
    "invalid_count" INTEGER NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" TEXT,

    CONSTRAINT "exclusion_lists_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exclusion_lists_workspace_id_id_key" ON "exclusion_lists"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "suppression_entries_workspace_id_exclusion_list_id_idx" ON "suppression_entries"("workspace_id", "exclusion_list_id");

-- AddForeignKey
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_workspace_id_exclusion_list_id_fkey" FOREIGN KEY ("workspace_id", "exclusion_list_id") REFERENCES "exclusion_lists"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (prisma/schema/contacts.prisma points here; contacts' docs/data.md). An entry imported
-- from a CSV belongs to its exclusion list, and only such an entry has one, whoever writes the row.
-- The source is compared as text: Postgres refuses the value `csv` inside the transaction that adds
-- it (20261102125800_contacts_suppression_channels does the same).
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_csv_list" CHECK (
    ("source"::text = 'csv') = ("exclusion_list_id" IS NOT NULL)
  );

-- No list is ever deleted, as no entry is (gamma-p2-040): removing one sets removed_at and
-- removed_by on it and on its active entries. app keeps SELECT, INSERT and UPDATE.
REVOKE DELETE ON TABLE "exclusion_lists" FROM app;
