// The run's queue of pages (README.md "Web research"; docs/flows.md; gamma-wr-045): after the picks,
// one step reads each pick file of the run in the plan's order and the source's start pages, and
// writes the queue, raw/signals/<runId>/pages/queue.json (queueOf, pages.ts: start pages first, then
// the picks round by round, a few pages of one host at most). A step run again finds the file and
// answers from it. Addresses stay in the file: the step answers a count.
import { tenantClient } from "@whytide/db";
import { settings } from "../../settings.ts";
import type { WebResearchConfig } from "../../sources/web_research/index.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { type RunRef, writeRunFile } from "../runs.ts";
import { pickKey, queueKey, readJsonFile } from "./files.ts";
import { type PickedUrls, type QueuedPage, queueOf } from "./pages.ts";

/** How the queue step ended: the pages lined up, or the source gone. */
export type Queued =
  | { readonly status: "queued"; readonly pages: number }
  | { readonly status: "gone" };

/**
 * The queue of the run, from the pick files of its `searches` searches. A search with no pick file
 * (never asked, or its pick failed) adds none.
 */
export async function queueResearchPages(
  ref: RunRef,
  searches: number,
  tenant: TenantRun,
): Promise<Queued> {
  const { workspaceId, runId } = ref;
  const filed = (await readJsonFile(workspaceId, queueKey(runId))) as {
    pages: QueuedPage[];
  } | null;
  if (filed !== null) return { status: "queued", pages: filed.pages.length };
  const source = await tenant(() =>
    tenantClient.signalSource.findFirst({ where: { id: ref.sourceId } }),
  );
  if (source === null) return { status: "gone" };
  const starts = (source.config as WebResearchConfig).startPages ?? [];
  const picks: PickedUrls[] = [];
  for (let position = 1; position <= searches; position += 1) {
    const pick = await readJsonFile(workspaceId, pickKey(runId, position));
    if (pick !== null) picks.push(pick as PickedUrls);
  }
  const pages = queueOf(starts, picks, settings.SIGNALS_RESEARCH_PAGES_PER_RUN);
  await writeRunFile(workspaceId, queueKey(runId), { pages });
  return { status: "queued", pages: pages.length };
}
