// The last plan of a research source, for the route and the card (README.md "Web research";
// gamma-wr-041): the newest of its plans, its words by language, its source types' ids and when it was
// made; null before any. A source of another workspace is gone to the tenant client, as for every route.
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { errors } from "../../errors.ts";

/** A plan's words of one language, as `signal_research_plans.words` holds them. */
type PlanWords = { readonly language: string; readonly words: readonly string[] };

export type LastPlan = {
  readonly id: string;
  readonly runId: string;
  readonly madeAt: Date;
  readonly words: readonly PlanWords[];
  readonly placeIds: readonly string[];
} | null;

/** The source's newest plan, signal_source_not_found for a source that is not the workspace's. */
export async function lastPlanOf(sourceId: string): Promise<LastPlan> {
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) throw new AppError(errors.signal_source_not_found);
  const plan = await tenantClient.signalResearchPlan.findFirst({
    where: { sourceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (plan === null) return null;
  const { id, runId, createdAt, placeIds } = plan;
  return {
    id,
    runId,
    madeAt: createdAt,
    words: plan.words as unknown as readonly PlanWords[],
    placeIds,
  };
}
