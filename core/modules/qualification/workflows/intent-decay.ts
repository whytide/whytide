// The nightly decay's activities (README "Intent and priority", docs/flows.md "The nightly decay"):
// the global tick's, which starts each workspace's qualification_intent_decay, and the page, which
// recomputes the rows whose intent is above 0 or that hold a boost, each person in a run of its own
// under its lock, so that a run holds one person's lock at a time. Everything as of the tick's time.
// The workspace ids, the time and counts in and out; nothing calls a provider.
import { type TenantClient, tenantClient } from "@whytide/db";
import { type ActivityContext, startWorkflow } from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { INTENT_DECAY_PAGE } from "../domain/intent/constants.ts";
import { updateIntent } from "../domain/score/score-snapshot.ts";
import { signalReader } from "../domain/signal-reader.ts";

type Context = ActivityContext<TenantClient>;

/**
 * The start of the workspace's decay as of `at`: one run at a time by its fixed id, so a start while
 * one runs starts none.
 */
export function intentDecayStart(workspaceId: string, at: string) {
  return {
    workflow: "qualification_intent_decay",
    input: { workspaceId, at },
    workflowId: `qualification.intent_decay:${workspaceId}:current`,
    oneAtATime: true,
  };
}

/**
 * The tick's activity: every workspace's decay started as of `at`. A workspace that fails leaves the
 * others started, and the tick then fails with its code. The counts only.
 */
export async function startIntentDecays(input: {
  at: string;
}): Promise<{ workspaces: number; started: number }> {
  // Tenancy's list: no module reads another's tables (decisions.md, 2026-10-22).
  const workspaceIds = await listWorkspaceIds();
  const failures: unknown[] = [];
  let started = 0;
  for (const workspaceId of workspaceIds) {
    try {
      if ((await startWorkflow(intentDecayStart(workspaceId, input.at))).started) started += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return { workspaces: workspaceIds.length, started };
}

/**
 * One page of the workspace's decay: up to INTENT_DECAY_PAGE rows computed before `at` whose intent
 * is above 0 or that hold a boost, by person id, each recomputed at `at`, which takes it out of the
 * next page (or deleted, for a lead with no decision). `more` while a page was full. With no reader,
 * none.
 */
export async function decayPage(
  input: { at: string },
  context: Context,
): Promise<{ updated: number; more: boolean }> {
  if (signalReader() === undefined) return { updated: 0, more: false };
  const at = new Date(input.at);
  const decaying = [{ intentScore: { gt: 0 } }, { boostUntil: { not: null } }];
  const rows = await context.tenant(() =>
    tenantClient.intentScore.findMany({
      where: { computedAt: { lt: at }, OR: decaying },
      select: { personId: true },
      orderBy: { personId: "asc" },
      take: INTENT_DECAY_PAGE,
    }),
  );
  for (const { personId } of rows) await context.tenant(() => updateIntent(personId, at));
  return { updated: rows.length, more: rows.length === INTENT_DECAY_PAGE };
}
