// A lookup asked for (README "Email lookups"), in the caller's tenant run: the request written
// `queued` with its key and trigger, and enrichment.lookup_requested published in the same run, so
// the event exists exactly when the request does; its subscriber starts the workflow (events.ts). A
// key given again answers its request; one left waiting (for credits or a verifier) or failed is
// queued again with its attempt raised and published again; a key of another person's request is
// refused. The request's own rows: its lock, and one step of providers_tried recorded while it
// runs. Ids, enums and codes only.
import { errors as contactsErrors, getPerson } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, isAppError, newId, publish } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { now } from "../clock.ts";
import { idOf } from "../readers.ts";
import { PRINTED_ADDRESS_MAX, type TriedEntry } from "./constants.ts";

export type LookupTrigger = "jit_step" | "request" | "reverify" | "found";
export type RequestStatus =
  | "queued"
  | "running"
  | "found"
  | "not_found"
  | "failed"
  | "skipped_suppressed"
  | "waiting_budget"
  | "waiting_allowance";
/** A request as the steps read it. */
export type RequestRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly personId: string;
  readonly trigger: LookupTrigger;
  readonly status: RequestStatus;
  readonly attempt: number;
  /** While it runs, the reason of a lookup of the lead's own sources (gamma-en-100); else null. */
  readonly reason: string | null;
  readonly providersTried: unknown;
  readonly contactPointId: string | null;
  readonly creditUsageId: string | null;
  /** The address a page printed with the person, while a lookup `found` runs (gamma-wr-070); else null. */
  readonly printedAddress: string | null;
};

/** The ends a key given again queues anew: the caller asks again later. */
const AGAIN: ReadonlySet<RequestStatus> = new Set([
  "waiting_budget",
  "waiting_allowance",
  "failed",
]);
const requestInput = z.strictObject({
  personId: z.string().trim().min(1).max(64),
  requestKey: z.string().trim().min(1).max(200),
  trigger: z.enum(["jit_step", "request", "found"]).optional(),
  address: z.string().trim().toLowerCase().email().max(PRINTED_ADDRESS_MAX).optional(),
});

/**
 * The person's work email looked up: `jit_step` (24 hours before the first email step, gamma-p4-010)
 * by default, `request` (a member's button), or `found` (a lead research found, gamma-wr-070). With
 * `found`, `address` is the address a page printed with the person: kept on the request only while
 * the lookup runs, and verified before any source is asked. `{ requestId, status }`.
 */
export function requestLookup(input: {
  personId: string;
  requestKey: string;
  trigger?: "jit_step" | "request" | "found";
  address?: string;
}): Promise<{ requestId: string; status: RequestStatus }> {
  return ask(input, input.trigger ?? "jit_step");
}

/** The person's active address verified again now, whatever its age; free. `{ requestId, status }`. */
export function requestReverification(input: {
  personId: string;
  requestKey: string;
}): Promise<{ requestId: string; status: RequestStatus }> {
  return ask(input, "reverify");
}

async function ask(
  input: { personId: string; requestKey: string; trigger?: string; address?: string },
  trigger: LookupTrigger,
): Promise<{ requestId: string; status: RequestStatus }> {
  const parsed = requestInput.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join("."));
    throw new AppError(errors.enrichment_input_invalid, { details: { fields } });
  }
  const { personId, requestKey, address } = parsed.data;
  // An address goes with the lookup at find only: the others are asked with no outside input.
  if (address !== undefined && trigger !== "found") {
    throw new AppError(errors.enrichment_input_invalid, { details: { fields: ["address"] } });
  }
  try {
    await getPerson(personId);
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) {
      throw new AppError(errors.enrichment_person_not_found);
    }
    throw error;
  }
  const { workspaceId } = currentTenant();
  const at = now();
  const id = newId(ids.enrichment_request);
  const { count } = await tenantClient.enrichmentRequest.createMany({
    data: [
      {
        ...{ id, workspaceId, personId, trigger, requestKey, createdAt: at, updatedAt: at },
        printedAddress: address ?? null,
      },
    ],
    skipDuplicates: true,
  });
  let requestId: string = id;
  let status: RequestStatus = "queued";
  if (count === 0) {
    // A key is its person's: one used for another person of the workspace (reused after the
    // host's 24 hours) answers no request of theirs and queues none again.
    const kept = await tenantClient.enrichmentRequest.findFirst({
      where: { requestKey, personId },
    });
    if (kept === null) {
      throw new AppError(errors.enrichment_input_invalid, { details: { fields: ["requestKey"] } });
    }
    requestId = kept.id;
    status = kept.status;
    if (!AGAIN.has(kept.status)) return { requestId, status };
    // Asked again: a new attempt, its own reservation key and workflow, its steps from none.
    await tenantClient.enrichmentRequest.update({
      where: { id: requestId },
      data: {
        status: "queued",
        attempt: { increment: 1 },
        reason: null,
        errorCode: null,
        providersTried: [],
        printedAddress: address ?? null,
        contactPointId: null,
        creditUsageId: null,
        finishedAt: null,
        updatedAt: at,
      },
    });
    status = "queued";
  }
  await publish(outboxWriter(tenantClient, workspaceId), events["enrichment.lookup_requested"], {
    requestId,
  });
  return { requestId, status };
}

/** The request of the workspace, its writers one at a time; none for one privacy erased. */
export async function lockedRequest(requestId: string): Promise<RequestRow | null> {
  const id = idOf("requestId", requestId);
  const lock = `enrichment.request:${currentTenant().workspaceId}:${id}`;
  await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
  return tenantClient.enrichmentRequest.findFirst({ where: { id } });
}

/** providers_tried as stored: its jsonb, written only as TriedEntry entries. */
export const triedEntries = (stored: unknown): TriedEntry[] =>
  Array.isArray(stored) ? (stored as TriedEntry[]) : [];

/**
 * Steps recorded on a running request, under its lock: none on one gone or ended. `once`: none when
 * the request has a step of that source and step already, the late answer of a step the workflow
 * recorded failed. Whether they were recorded, and the entries before them.
 */
export async function recordSteps(
  requestId: string,
  entries: readonly TriedEntry[],
  once?: { readonly source: string; readonly step: TriedEntry["step"] },
): Promise<{ recorded: boolean; before: TriedEntry[] }> {
  const request = await lockedRequest(requestId);
  if (request === null || request.status !== "running") return { recorded: false, before: [] };
  const before = triedEntries(request.providersTried);
  const twice = once && before.some((e) => e.source === once.source && e.step === once.step);
  if (twice) return { recorded: false, before };
  await tenantClient.enrichmentRequest.update({
    where: { id: request.id },
    data: { providersTried: [...before, ...entries], updatedAt: now() },
  });
  return { recorded: true, before };
}
