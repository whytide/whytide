// The 30-day rule's job (README.md "The 30-day rule", docs/flows.md "The 30-day rule"): a workspace's
// candidates, read through contacts' listPersons a page per tenant run; each deleted through erase in
// a run of its own, as the service privacy, with the reason retention_never_contacted, the operator
// RETENTION_OPERATOR, the guard and the recheck, RETENTION_MAX_PER_RUN at most; then, for the deleted
// ids, every registered eraser again, the sweep, in a run per person. Ids and counts in and out: no
// log line or answer names a person, and the erasures keep no hash of one.
import {
  errors as contactsErrors,
  type LockedPerson,
  lastTouchAt,
  listPersons,
} from "@whytide/contacts";
import { withTenant } from "@whytide/db";
import { isAppError, type Logger, servicePrincipal } from "@whytide/platform";
import { givenClient } from "../client.ts";
import { ERASE_TIMEOUT_MS } from "../erase/constants.ts";
import { type ErasureRecheck, erase } from "../erase/erase.ts";
import { FIRST } from "../erase/erasers.ts";
import { type Eraser, registeredErasers } from "../erase/registry.ts";
import { kindOf } from "../kind.ts";
import { isCandidate } from "./candidates.ts";
import { RETENTION_MAX_PER_RUN, RETENTION_OPERATOR, RETENTION_PAGE } from "./constants.ts";

/** What one workspace's run did: counts, and the ids of the persons it deleted, for the sweep. */
export type RetentionRun = {
  readonly candidates: number;
  readonly deleted: number;
  /** Refused by the guard (`touched`) or gone before their run (`gone`). */
  readonly skipped: number;
  readonly failed: number;
  readonly deletedIds: readonly string[];
};

/** The workflow's sums over the workspaces' runs. */
export type RetentionTotals = {
  readonly workspaces: number;
  readonly candidates: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly failed: number;
  /** The workspaces whose run failed past its attempts. */
  readonly workspacesFailed: number;
};

/** The sweep's input: the persons each workspace's run deleted, and the totals it logs. */
export type RetentionSweep = {
  readonly deleted: readonly {
    readonly workspace: string;
    readonly personIds: readonly string[];
  }[];
  readonly totals: RetentionTotals;
};

/** What the sweep erased again, by `<module>.<table>`, and the persons whose sweep failed. */
export type RetentionSwept = {
  readonly rows: Readonly<Record<string, number>>;
  readonly failed: number;
};

const principal = servicePrincipal("privacy");
const RAN = "privacy: retention ran";
let cap: number | undefined;

/** For tests (testing/): the deletions of a workspace's run in place of RETENTION_MAX_PER_RUN. */
export function useRetentionCap(next: number | undefined): void {
  cap = next;
}

/** One tenant run of the workspace as the service privacy, on the process's client or a test's. */
function inWorkspace<T>(workspaceId: string, fn: () => Promise<T>, timeout?: number): Promise<T> {
  return withTenant({ workspaceId, principal }, fn, { client: givenClient(), timeout });
}

/** The workspace's candidates at the cutoff, oldest found first: their ids. A page per run. */
export async function candidatesOf(workspaceId: string, cutoff: Date): Promise<string[]> {
  const found: { id: string; createdAt: Date }[] = [];
  let cursor: string | undefined;
  do {
    const after = cursor;
    const page = await inWorkspace(workspaceId, () =>
      listPersons({ limit: RETENTION_PAGE, cursor: after }),
    );
    for (const person of page.persons) {
      if (isCandidate(person, cutoff)) found.push({ id: person.id, createdAt: person.createdAt });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  found.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return found.map(({ id }) => id);
}

/** The job's guard, a first look after the lead's lock: still never touched, else `touched`; `gone`. */
async function untouched(personId: string): Promise<string | null> {
  try {
    return (await lastTouchAt(personId)) === null ? null : "touched";
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return "gone";
    throw error;
  }
}

/**
 * The job's recheck, on the person's row read under its lock right before contacts deletes it, so
 * that a touch still being written is waited for: still never touched, else `touched`; still a
 * candidate at the cutoff, else `changed` (a country off the list, set since the read).
 */
function recheckAt(cutoff: Date) {
  return async (person: LockedPerson): Promise<string | null> => {
    if (person.lastTouchAt !== null) return "touched";
    return isCandidate(person, cutoff) ? null : "changed";
  };
}

/** One candidate through erase: deleted, skipped, or the code or class of its failure. */
async function deleteOne(workspaceId: string, personId: string, recheck: ErasureRecheck) {
  try {
    const erased = await erase({
      workspaceId,
      person: { id: personId },
      operator: RETENTION_OPERATOR,
      dryRun: false,
      reason: "retention_never_contacted",
      guard: untouched,
      recheck,
    });
    return "skipped" in erased ? "skipped" : "deleted";
  } catch (error) {
    // Gone before its run started: erased meanwhile, or deleted by an earlier attempt of the run.
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return "skipped";
    return { failed: kindOf(error) };
  }
}

/**
 * The workspace's run: its candidates at the cutoff, oldest first, each deleted in a tenant run of
 * its own until RETENTION_MAX_PER_RUN are; the rest wait for the next day. A person that fails leaves
 * the others to go on. One log line of counts.
 */
export async function runRetention(
  workspaceId: string,
  cutoff: Date,
  log: Logger,
): Promise<RetentionRun> {
  const candidates = await candidatesOf(workspaceId, cutoff);
  const most = cap ?? RETENTION_MAX_PER_RUN;
  const recheck = recheckAt(cutoff);
  const deletedIds: string[] = [];
  let skipped = 0;
  let failed = 0;
  for (const personId of candidates) {
    if (deletedIds.length >= most) break;
    const outcome = await deleteOne(workspaceId, personId, recheck);
    if (outcome === "deleted") deletedIds.push(personId);
    else if (outcome === "skipped") skipped += 1;
    else {
      failed += 1;
      log.warn(
        { workspace_id: workspaceId, code: outcome.failed },
        "privacy: a retention deletion failed",
      );
    }
  }
  const run = { candidates: candidates.length, deleted: deletedIds.length, skipped, failed };
  log.info(
    {
      workspace_id: workspaceId,
      candidate_count: run.candidates,
      deleted_count: run.deleted,
      skipped_count: skipped,
      failed_count: failed,
    },
    RAN,
  );
  return { ...run, deletedIds };
}

/**
 * The sweep: for each deleted person, every registered eraser again, the platform's first as in an
 * erasure, in a tenant run per person, so that a row a batch or a draft in flight wrote for the id
 * after its deletion goes too. contacts' is not among them: the person is gone. Then the line of the
 * totals with the rows erased again, by table. A person whose sweep fails leaves the others.
 */
export async function sweepRetention(
  input: RetentionSweep,
  log: Logger,
  erasers: readonly Eraser[] = registeredErasers(),
): Promise<RetentionSwept> {
  const ordered = [
    ...erasers.filter(({ module }) => module === FIRST),
    ...erasers.filter(({ module }) => module !== FIRST),
  ];
  const rows: Record<string, number> = {};
  let failed = 0;
  for (const { workspace, personIds } of input.deleted) {
    for (const personId of personIds) {
      const sweep = async () => {
        const found: [string, number][] = [];
        for (const { module, erase: eraseRows } of ordered) {
          const counts = await eraseRows(personId);
          for (const [table, n] of Object.entries(counts)) found.push([`${module}.${table}`, n]);
        }
        return found;
      };
      try {
        for (const [key, n] of await inWorkspace(workspace, sweep, ERASE_TIMEOUT_MS)) {
          rows[key] = (rows[key] ?? 0) + n;
        }
      } catch (error) {
        failed += 1;
        log.warn(
          { workspace_id: workspace, code: kindOf(error) },
          "privacy: a retention sweep failed",
        );
      }
    }
  }
  const { totals } = input;
  const byTable = Object.entries(rows).map(([key, n]) => [
    `swept_${key.replace(".", "_")}_count`,
    n,
  ]);
  log.info(
    {
      workspace_count: totals.workspaces,
      candidate_count: totals.candidates,
      deleted_count: totals.deleted,
      skipped_count: totals.skipped,
      failed_count: totals.failed,
      workspace_failed_count: totals.workspacesFailed,
      sweep_failed_count: failed,
      swept_count: Object.values(rows).reduce((sum, n) => sum + n, 0),
      ...Object.fromEntries(byTable),
    },
    RAN,
  );
  return { rows, failed };
}
