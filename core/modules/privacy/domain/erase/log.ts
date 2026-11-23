// The erasure log (docs/data.md): one row per erasure committed, written last in its run, with its
// reason and, for a request, the salted hash contacts keeps of the person's URL, or of their first
// email address for a person without a LinkedIn profile (gamma-rf-050); no other data about the
// person, never an address. A deletion of the 30-day rule, or of a lead, keeps no hash: the CHECK
// erasure_log_reason_hash.
import { tenantClient } from "@whytide/db";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import type { ErasureCounts } from "./registry.ts";

/**
 * Why a person was erased: a request (`pnpm erase`), the 30-day rule's job, or a lead deleted so that
 * it can be added again (`pnpm lead:delete`).
 */
export type ErasureReason = "request" | "retention_never_contacted" | "lead_deleted";

export type ErasureEntry = {
  /**
   * The erased hash of the person's URL, else of their first email address, as contacts' erasePerson
   * wrote it; null for every other reason.
   */
  readonly personHash: string | null;
  readonly reason: ErasureReason;
  readonly requestedAt: Date;
  /** The rows deleted, by module and table. */
  readonly counts: Readonly<Record<string, ErasureCounts>>;
  /** The operator who ran the command, or the job's name; never the person. */
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
