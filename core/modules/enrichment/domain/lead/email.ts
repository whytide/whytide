// The lead page's Email panel (gamma-en-081; README "The Email panel"), in the caller's tenant run:
// the person's held address, the one "Verify again" checks (a work one first, whatever its
// verification), with its kind, verification, source class and times, and whether it waits for
// consent (the owner's UK and EU switch); the person's last lookup, its status and reason. Never a
// finder's or verifier's name, nor a step of providers_tried (RB-7.3.2). A request from the panel:
// a lookup or a re-verification, under the member's key, or the person's request already at work.
import { tenantClient } from "@whytide/db";
import { currentTenant } from "@whytide/platform";
import type { MissingReason } from "../lookup/constants.ts";
import { needsConsent } from "../lookup/key.ts";
import { activePoint } from "../lookup/points.ts";
import { type RequestStatus, requestLookup, requestReverification } from "../lookup/request.ts";
import { personalEmailEuUk } from "../lookup/switch.ts";
import {
  EMAIL_KEY_PREFIX,
  type EmailAction,
  LEAD_EMAIL_LOCK,
  WORKING_STATUSES,
} from "./constants.ts";
import { personOf } from "./read.ts";

const WORKING: ReadonlySet<string> = new Set(WORKING_STATUSES);

export type LeadEmail = {
  readonly email: {
    readonly address: string;
    readonly kind: "work_email" | "personal_email";
    readonly verification: "valid" | "catch_all" | "risky" | "invalid" | "unknown";
    /** The contact point's class (`email_finder`…), never the provider that found it. */
    readonly sourceClass: string;
    readonly verifiedAt: Date;
    readonly acquiredAt: Date;
    /** A personal address no email goes to while ENRICHMENT_PERSONAL_EMAIL_EU_UK is off. */
    readonly needsConsent: boolean;
  } | null;
  readonly lastLookup: {
    readonly requestId: string;
    readonly trigger: "jit_step" | "request" | "reverify" | "found";
    readonly status: RequestStatus;
    /** Why it ended without an address (MISSING_REASONS), null otherwise. */
    readonly reason: MissingReason | null;
    readonly finishedAt: Date | null;
  } | null;
};

/** The person's held address and last lookup; enrichment_person_not_found. */
export async function leadEmail(personId: string): Promise<LeadEmail> {
  const person = await personOf(personId);
  const held = await activePoint(person.id);
  const row =
    held &&
    (await tenantClient.contactPoint.findFirstOrThrow({
      where: { id: held.id },
      select: {
        value: true,
        kind: true,
        verification: true,
        sourceClass: true,
        verifiedAt: true,
        acquiredAt: true,
      },
    }));
  // An address row always holds both (the table's CHECK); a phone is never `held`.
  const point =
    row && row.kind !== "phone" && row.verification !== null && row.verifiedAt !== null
      ? { ...row, kind: row.kind, verification: row.verification, verifiedAt: row.verifiedAt }
      : null;
  const last = await tenantClient.enrichmentRequest.findFirst({
    where: { personId: person.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, trigger: true, status: true, reason: true, finishedAt: true },
  });
  const waits =
    point?.kind === "personal_email" && needsConsent(person.locationCountry, personalEmailEuUk());
  return {
    email: point && {
      address: point.value,
      kind: point.kind,
      verification: point.verification,
      sourceClass: point.sourceClass,
      verifiedAt: point.verifiedAt,
      acquiredAt: point.acquiredAt,
      needsConsent: waits,
    },
    lastLookup: last && {
      requestId: last.id,
      trigger: last.trigger,
      status: last.status,
      // The settle writes only MISSING_REASONS (domain/lookup/outcome.ts); a running lookup of the
      // lead's own sources keeps its plan's reason for the settle (gamma-en-100), not shown.
      reason: WORKING.has(last.status) ? null : (last.reason as MissingReason | null),
      finishedAt: last.finishedAt,
    },
  };
}

/**
 * The panel's request under the member's key: "Find email", a lookup (`request`), or "Verify again",
 * the held address checked again, free. `{ requestId, status }`; the same key, the same request.
 * While the person has a request queued or running, whatever its trigger (another tab, another
 * member, the email step's), that one answers and none is written: a second would reserve credits
 * again. The person's lock makes two presses at once one. enrichment_person_not_found,
 * enrichment_input_invalid.
 */
export async function requestLeadEmail(
  personId: string,
  key: string,
  action: EmailAction,
): Promise<{ requestId: string; status: RequestStatus }> {
  const person = await personOf(personId);
  const lock = `${LEAD_EMAIL_LOCK}:${currentTenant().workspaceId}:${person.id}`;
  await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
  const working = await tenantClient.enrichmentRequest.findFirst({
    where: { personId: person.id, status: { in: [...WORKING_STATUSES] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true },
  });
  if (working !== null) return { requestId: working.id, status: working.status };
  const requestKey = `${EMAIL_KEY_PREFIX[action]}:${key}`;
  return action === "verify"
    ? requestReverification({ personId: person.id, requestKey })
    : requestLookup({ personId: person.id, requestKey, trigger: "request" });
}
