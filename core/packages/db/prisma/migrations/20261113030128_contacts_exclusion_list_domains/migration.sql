-- CreateTable
CREATE TABLE "exclusion_list_domains" (
    "workspace_id" TEXT NOT NULL,
    "exclusion_list_id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "exclusion_list_domains_pkey" PRIMARY KEY ("workspace_id","exclusion_list_id","hash")
);

-- CreateIndex
CREATE INDEX "exclusion_list_domains_workspace_id_hash_idx" ON "exclusion_list_domains"("workspace_id", "hash");

-- AddForeignKey
ALTER TABLE "exclusion_list_domains" ADD CONSTRAINT "exclusion_list_domains_workspace_id_exclusion_list_id_fkey" FOREIGN KEY ("workspace_id", "exclusion_list_id") REFERENCES "exclusion_lists"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (prisma/schema/contacts.prisma points here; contacts' docs/data.md). A list's domains
-- are written once, by its import, and never change: app keeps SELECT and INSERT, as no list or entry
-- is ever deleted (gamma-p2-045).
REVOKE UPDATE, DELETE ON TABLE "exclusion_list_domains" FROM app;

-- The lists imported before this migration: each csv entry's hash with its list, removed entries
-- included, as the import now writes every domain its file names. Their duplicates were never stored,
-- so such a list names only the domains it added. Run again, it writes nothing.
INSERT INTO "exclusion_list_domains" ("workspace_id", "exclusion_list_id", "hash")
SELECT "workspace_id", "exclusion_list_id", "hash" FROM "suppression_entries"
WHERE "source"::text = 'csv' AND "exclusion_list_id" IS NOT NULL
ON CONFLICT DO NOTHING;
