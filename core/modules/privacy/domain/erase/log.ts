// The erasure log (docs/data.md): one row per erasure the script commits, written last in its run,
// with the salted hash contacts keeps of the person's URL and no other data about the person.
import { tenantClient } from "@whytide/db";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import type { ErasureCounts } from "./registry.ts";

export type ErasureEntry = {
  /** The erased hash of the person's URL, as contacts' erasePerson wrote it. */
  readonly personHash: string;
  readonly requestedAt: Date;
  /** The rows deleted, by module and table. */
  readonly counts: Readonly<Record<string, ErasureCounts>>;
  /** The operator who ran the command, never the person. */
  readonly performedBy: string;
};

/** Writes the run's log row, completed now, in the caller's tenant run; its id. */
export async function writeErasureLog(entry: ErasureEntry): Promise<string> {
  const id = newId(ids.erasure_log);
  const { workspaceId } = currentTenant();
  const completedAt = new Date();
  await tenantClient.erasureLog.create({ data: { id, workspaceId, ...entry, completedAt } });
  return id;
}
