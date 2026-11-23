// A page of the run's queue, read (README.md "Web research"; docs/flows.md; gamma-wr-045): one page a
// step, by its place in the queue, through readResearchPage (read-page.ts). At the pages' limit
// (SIGNALS_RESEARCH_PAGES_PER_RUN, the pages read so far told by the workflow) nothing is fetched and
// the run's `counts.budget_reached` is set once; a page whose file is there already, from an attempt
// before this one, is not fetched again; else the page goes to the files port as
// raw/signals/<runId>/pages/<n>.json, and the run's counts say how many pages were read, closed by
// robots.txt or failed. The step answers a status only: no address, title or text reaches a log, a
// span, a metric or the workflow's history.

import { tenantClient } from "@whytide/db";
import { settings } from "../../settings.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef, writeRunFile } from "../runs.ts";
import {
  COUNT_BUDGET_REACHED,
  COUNT_PAGES,
  COUNT_PAGES_CLOSED,
  COUNT_PAGES_FAILED,
} from "./constants.ts";
import { pageKey, queueKey, readJsonFile } from "./files.ts";
import type { QueuedPage } from "./pages.ts";
import { readResearchPage } from "./read-page.ts";

/** How a page step ended: read (now or by an earlier attempt), closed, failed, skipped (no such page) or at the limit. */
export type PageStep = {
  readonly status: "read" | "closed" | "failed" | "skipped" | "budget";
};

/**
 * The `index`th page of the queue (from 1), `read` pages having been read before it in this run.
 * A fault the reader throws (no code) is thrown, for the activity's attempts.
 */
export async function readQueuedPage(
  ref: RunRef,
  index: number,
  read: number,
  tenant: TenantRun,
): Promise<PageStep> {
  const { workspaceId, runId } = ref;
  if (read >= settings.SIGNALS_RESEARCH_PAGES_PER_RUN) {
    await tenant(() => budgetReached(runId));
    return { status: "budget" };
  }
  if ((await readJsonFile(workspaceId, pageKey(runId, index))) !== null) return { status: "read" };
  const queue = (await readJsonFile(workspaceId, queueKey(runId))) as {
    pages: QueuedPage[];
  } | null;
  const queued = queue?.pages[index - 1];
  if (queued === undefined) return { status: "skipped" };
  const answer = await readResearchPage(runId, queued.url);
  if (answer.status !== "read") {
    const count = answer.status === "closed" ? COUNT_PAGES_CLOSED : COUNT_PAGES_FAILED;
    await tenant(() => addCounts(runId, { [count]: 1 }));
    return { status: answer.status };
  }
  const { page, rendered } = answer;
  const { title, text, links, mailto } = page;
  const body = {
    ...{ url: queued.url, finalUrl: page.url, placeId: queued.placeId },
    ...(queued.queryId === undefined ? {} : { queryId: queued.queryId }),
  };
  await writeRunFile(workspaceId, pageKey(runId, index), {
    ...body,
    ...{ title, text, links, mailto, status: page.status, rendered },
  });
  await tenant(() => addCounts(runId, { [COUNT_PAGES]: 1 }));
  return { status: "read" };
}

/** The run's `budget_reached` set once: the search's limit may have set it already. */
async function budgetReached(runId: string): Promise<void> {
  const row = await tenantClient.signalRun.findFirst({ where: { id: runId } });
  const counts = (row?.counts ?? {}) as Record<string, number>;
  if (counts[COUNT_BUDGET_REACHED] === undefined)
    await addCounts(runId, { [COUNT_BUDGET_REACHED]: 1 });
}
