-- CreateTable
CREATE TABLE "intent_scores" (
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "intent_score" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL,
    "tier" "score_tier",
    "intent_breakdown" JSONB NOT NULL,
    "why_now_event_id" TEXT,
    "boost_until" TIMESTAMPTZ,
    "scorer_version" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "intent_scores_pkey" PRIMARY KEY ("workspace_id","person_id")
);

-- Hand-written (prisma/schema/qualification.prisma points here). The intent and the priority are 0
-- to 100 (core/modules/qualification domain/intent/).
ALTER TABLE "intent_scores" ADD CONSTRAINT "intent_scores_bounds" CHECK ("intent_score" BETWEEN 0 AND 100 AND "priority" BETWEEN 0 AND 100);
