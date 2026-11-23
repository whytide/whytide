// enrichment's reads (README "Public interface"), in the caller's tenant run: a person's last run and
// the sources one run asked, names, outcomes, codes and field names, never a value (gamma-en-055's
// panel reads both).
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { errors } from "../errors.ts";
import { type SourceTried, triedOf } from "./plan.ts";

export type LastRun = {
  readonly runId: string;
  readonly trigger: "new_lead" | "request";
  readonly status: "queued" | "running" | "done" | "failed";
  readonly filled: readonly string[];
  readonly finishedAt: Date | null;
};

/** The person's latest run, or null for none. */
export async function lastRunOf(personId: string): Promise<LastRun | null> {
  const run = await tenantClient.enrichmentRun.findFirst({
    where: { personId: idOf("personId", personId) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (run === null) return null;
  const { id: runId, trigger, status, filled, finishedAt } = run;
  return { runId, trigger, status, filled, finishedAt };
}

/** The sources the run asked, in order; none for a run the workspace does not have. */
export async function sourcesTried(runId: string): Promise<readonly SourceTried[]> {
  const run = await tenantClient.enrichmentRun.findFirst({
    where: { id: idOf("runId", runId) },
    select: { sourcesTried: true },
  });
  return triedOf(run?.sourcesTried);
}

/** Prisma drops an undefined value from a where: unchecked, that would be any row. */
export function idOf(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(errors.enrichment_input_invalid, { details: { fields: [field] } });
  }
  return value;
}
