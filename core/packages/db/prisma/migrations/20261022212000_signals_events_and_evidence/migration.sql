-- CreateTable
CREATE TABLE "signal_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "source_id" TEXT,
    "run_id" TEXT,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "excerpt" TEXT,
    "comment_text" TEXT,
    "reaction" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "reduced_at" TIMESTAMPTZ,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signal_events_workspace_id_person_id_occurred_at_idx" ON "signal_events"("workspace_id", "person_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "signal_events_workspace_id_id_key" ON "signal_events"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_events_workspace_id_dedupe_key_key" ON "signal_events"("workspace_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_workspace_id_id_key" ON "evidence"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_workspace_id_event_id_key" ON "evidence"("workspace_id", "event_id");

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "signal_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "signal_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "signal_events"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
