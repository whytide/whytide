// `pnpm -F contacts companies:link`'s work (gamma-rf-010; README.md "Shared companies"), in the
// caller's tenant run: the workspace's rows with no link, read in batches of ids, each linked in a
// run of its own (link.ts), so a run holds the locks of one company at a time. Safe to run again: a
// linked row is never read again, and a link never changes. Counts and ids only, never a value.
import { LINK_BATCH } from "./constants.ts";
import { linkRow } from "./link.ts";
import { runGroup } from "./sharing.ts";
import { unlinkedRows } from "./store.ts";

/** What linking one row did: linked; nothing, as it has no key or its workspace no group. */
export type LinkOutcome = "linked" | "no_key" | "no_group";

/** The run's workspace's rows with no link, after `after` in id order, LINK_BATCH at most. */
export function unlinkedCompanies(after: string | null): Promise<string[]> {
  return unlinkedRows(after ?? "", LINK_BATCH);
}

/** Links the run's workspace's row with the id, if it has no link yet. */
export async function linkCompany(id: string): Promise<LinkOutcome> {
  const group = await runGroup();
  if (group === null) return "no_group";
  const linked = await linkRow(id, group);
  return linked?.companyId == null ? "no_key" : "linked";
}
