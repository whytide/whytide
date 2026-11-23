// The lookup's first step (docs/flows.md "The lookup", step 1), one tenant run, free, no vendor call:
// the first end that applies wins, then the credits reserved before any outside call and the plan.
// A lookup: the person suppressed or gone; an active, valid address verified within
// ENRICHMENT_EMAIL_VALID_DAYS (settings.ts); no name; a live cache entry, whose address a block holds ending it
// skipped_suppressed (gamma-rf-040); no verifier with a call left this period. No
// company domain, a company domain found catch-all, or the credits short plan only the lead's own
// sources, those with anyDomain, nothing reserved and the reason kept for the settle; with none
// listed, they end there (gamma-en-100). A list of the lead's own sources only reserves nothing: an
// address the lead gave is free. A re-verification: suppressed, no active address, a personal one
// waiting for consent (the owner's UK and EU switch), no verifier; it reserves nothing. A free end
// publishes its event in this run. A lookup `found` that holds the address a page printed with the
// person (gamma-wr-070) plans a step of its own first, `printed`, before every source: a free end
// empties the address as the settle does.
import { getPerson, refreshCompany, suppressionOf } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { credits, creditsCodes, currentTenant, isAppError, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { prices } from "../../prices.ts";
import { settings } from "../../settings.ts";
import { now } from "../clock.ts";
import { DB_TIMEOUT_SECONDS, PROVIDER_TIMEOUT_SECONDS } from "../constants.ts";
import type { EmailSourceDefinition } from "../sources/define.ts";
import {
  FINDER_SOURCE_CLASS,
  LOOKUP_QUANTITY,
  type MissingReason,
  type OwnSourcesReason,
  PRINTED,
  RESERVATION_PREFIX,
} from "./constants.ts";
import { keyHashOf, kindOf, needsConsent, normalDomain } from "./key.ts";
import { activePoint, keepAddress, usablePoint, validSince } from "./points.ts";
import { lockedRequest, type RequestRow, type RequestStatus } from "./request.ts";
import type { LoadedEmail } from "./sources.ts";
import { personalEmailEuUk } from "./switch.ts";

/** A source of the plan: its name, its activity kind and its timeout. */
export type LookupPlanEntry = {
  readonly source: string;
  readonly activityKind: EmailSourceDefinition["activityKind"];
  readonly timeoutSeconds: number;
};
/** The plan, names and numbers only: ended here, or the sources and the verifiers' turns. */
export type LookupPlan =
  | { readonly settled: true; readonly status: RequestStatus }
  | {
      readonly settled: false;
      readonly reverify: boolean;
      readonly sources: readonly LookupPlanEntry[];
      readonly verifiers: readonly string[];
      readonly maxCandidates: number;
    };

/**
 * `open`: whether any verifier has a call left this period (verifierOpen, read outside the run). The
 * company is read through contacts' refreshCompany (gamma-rf-010), with a domain its organization or
 * the shared company knows.
 */
export async function prepareLookup(
  requestId: string,
  loaded: LoadedEmail,
  open: boolean,
): Promise<LookupPlan> {
  const request = await lockedRequest(requestId);
  // Erased by privacy, or ended already (a step tried again): nothing more.
  if (request === null) return { settled: true, status: "not_found" };
  if (request.status !== "queued" && request.status !== "running") {
    return { settled: true, status: request.status };
  }
  const at = now();
  const end = (status: RequestStatus, reason: MissingReason | null, contactPointId?: string) =>
    endFree(request, { status, reason, contactPointId: contactPointId ?? null }, at);
  const verifiers = loaded.verifiers.map(({ name }) => name);
  if ((await suppressionOf(request.personId, { newEnrollment: false })).suppressed) {
    return end("skipped_suppressed", "suppressed");
  }
  if (request.trigger === "reverify") {
    const point = await activePoint(request.personId);
    if (point === null) return end("not_found", "no_address");
    // A held personal address waiting for consent goes to no verifier, as a candidate would not.
    if (point.kind === "personal_email") {
      const { locationCountry } = await getPerson(request.personId);
      if (needsConsent(locationCountry, personalEmailEuUk())) {
        return end("not_found", "personal_needs_consent");
      }
    }
    if (!open) return end("waiting_allowance", "no_verifier_left");
    await running(request, at, { contactPointId: point.id });
    return { settled: false, reverify: true, sources: [], verifiers, maxCandidates: 1 };
  }
  const person = await getPerson(request.personId);
  const personal = !needsConsent(person.locationCountry, personalEmailEuUk());
  const usable = await usablePoint(person.id, personal, validSince(at));
  if (usable !== null) return end("found", null, usable.id);
  const firstName = person.firstName?.trim() ?? "";
  const lastName = person.lastName?.trim() ?? "";
  if (firstName === "" || lastName === "") return end("not_found", "no_name");
  const company = person.companyId === null ? null : await refreshCompany(person.companyId);
  const domain = normalDomain(company?.domain);
  const own = loaded.sources.filter((source) => source.anyDomain === true);
  // The lead's own sources only, nothing reserved; none listed, or no verifier to check what they
  // propose, and the lookup ends here as before (gamma-en-100).
  const ownSources = async (status: RequestStatus, reason: OwnSourcesReason) => {
    if (own.length === 0 || !open) return end(status, reason);
    await running(request, at, { reason });
    return planOf(own, verifiers);
  };
  if (domain === "") return ownSources("not_found", "no_domain");
  const keyHash = keyHashOf(firstName, lastName, domain);
  const entries = await tenantClient.enrichmentCacheEntry.findMany({
    where: { keyHash, expiresAt: { gt: at } },
  });
  const email = entries.find((entry) => entry.kind === "email" && entry.value !== null);
  if (email?.value) {
    const kind = kindOf(email.value, domain);
    if (kind === "work_email" || personal) {
      const stamp = { sourceClass: FINDER_SOURCE_CLASS, provider: email.provider };
      const kept = await keepAddress(person.id, {
        address: email.value,
        kind,
        ...stamp,
        verifiedAt: email.retrievedAt,
      });
      if (kept.contactPointId !== null) return end("found", null, kept.contactPointId);
      // A cached address the never-contact list holds now (gamma-rf-040): kept nowhere, free.
      if (kept.holder === "suppressed") return end("skipped_suppressed", "suppressed");
      return end("not_found", kept.holder === "other_person" ? "held_by_other_person" : "bounced");
    }
  }
  // A cached negative entry ends the lookup, but not before an address printed with the person: it is
  // evidence the cache never saw, so it is verified first (gamma-wr-070), the sources not asked.
  const negative = entries.some((entry) => entry.kind === "negative");
  const printed = request.printedAddress !== null;
  if (negative && !printed) return end("not_found", "cached_negative");
  const catchAll = await tenantClient.emailDomainStatus.findFirst({
    where: { domain, catchAll: true, expiresAt: { gt: at } },
  });
  if (catchAll !== null) return ownSources("not_found", "catch_all");
  if (!open) return end("waiting_allowance", "no_verifier_left");
  // Only a source at the company's domain can find an address that costs credits.
  let usageId: string | null = null;
  if (own.length < loaded.sources.length) {
    try {
      ({ usageId } = await credits.reserve({
        workspaceId: request.workspaceId,
        action: prices["enrichment.work_email"],
        quantity: LOOKUP_QUANTITY,
        idempotencyKey: `${RESERVATION_PREFIX}:${request.id}:${request.attempt}`,
        subjectRef: request.id,
        lease: "async",
      }));
    } catch (error) {
      if (isAppError(error) && error.code === creditsCodes.insufficient_credits) {
        return ownSources("waiting_budget", "insufficient_credits");
      }
      throw error;
    }
  }
  await running(request, at, { creditUsageId: usageId, reason: null });
  return planOf(negative ? [] : loaded.sources, verifiers, printed);
}

/**
 * The plan of these sources, in their order: names, activity kinds and timeouts only. `printed`: the
 * request holds an address a page printed with the person, whose step goes first.
 */
function planOf(
  sources: readonly EmailSourceDefinition[],
  verifiers: readonly string[],
  printed = false,
): LookupPlan {
  const own: LookupPlanEntry[] = printed
    ? [{ source: PRINTED.name, activityKind: "db", timeoutSeconds: DB_TIMEOUT_SECONDS }]
    : [];
  const entries = sources.map(({ name, activityKind, timeoutSeconds }) => ({
    source: name,
    activityKind,
    // The company sources' rule (runs.ts): its own, else 15 for a provider and 60 for the others.
    timeoutSeconds:
      timeoutSeconds ??
      (activityKind === "provider" ? PROVIDER_TIMEOUT_SECONDS : DB_TIMEOUT_SECONDS),
  }));
  const maxCandidates = settings.ENRICHMENT_EMAIL_MAX_CANDIDATES;
  return {
    ...{ settled: false, reverify: false, sources: [...own, ...entries] },
    ...{ verifiers, maxCandidates },
  };
}

/**
 * The request running: its contact point (a re-verification), its reservation, and the reason of a
 * lookup of the lead's own sources, written each time, so a prepare tried again leaves no other's.
 */
async function running(
  request: RequestRow,
  at: Date,
  data: { contactPointId?: string; creditUsageId?: string | null; reason?: MissingReason | null },
): Promise<void> {
  await tenantClient.enrichmentRequest.update({
    where: { id: request.id },
    data: { status: "running", updatedAt: at, ...data },
  });
}

/** A free end: the request ended, its event published in the same run. */
async function endFree(
  request: RequestRow,
  ended: { status: RequestStatus; reason: MissingReason | null; contactPointId: string | null },
  at: Date,
): Promise<LookupPlan> {
  const { status, reason, contactPointId } = ended;
  await tenantClient.enrichmentRequest.update({
    where: { id: request.id },
    data: { status, reason, contactPointId, printedAddress: null, finishedAt: at, updatedAt: at },
  });
  await publishEnd(request, { reason, contactPointId });
  return { settled: true, status };
}

/** The lookup's event: address_verified with the contact point, else address_missing and why. */
export async function publishEnd(
  request: { readonly id: string; readonly personId: string },
  ended: { readonly reason: MissingReason | null; readonly contactPointId: string | null },
): Promise<void> {
  const outbox = outboxWriter(tenantClient, currentTenant().workspaceId);
  const { id: requestId, personId } = request;
  if (ended.contactPointId !== null && ended.reason === null) {
    const { contactPointId } = ended;
    await publish(outbox, events["enrichment.address_verified"], {
      requestId,
      personId,
      contactPointId,
    });
    return;
  }
  const reason = ended.reason ?? "no_result";
  await publish(outbox, events["enrichment.address_missing"], { requestId, personId, reason });
}
