// The lookup's outcome tables (docs/flows.md "The settle"), pure, so that the workflow's sandbox
// reads the ends and the tests read the rows: how a lookup or a re-verification ended, and what the
// settle writes for it (the request's status and reason, the cache, the domain's status, the
// credits, the event). Only a verifier's `valid` on an address no other person holds commits, and
// never for an address the lead gave or in a lookup of the lead's own sources (gamma-en-100). A valid
// address the never-contact list holds is never kept: skipped_suppressed, released (gamma-rf-040).
import {
  type MissingReason,
  OWN_SOURCES_REASONS,
  type OwnSourcesReason,
  type TriedEntry,
  VERDICTS,
  type Verdict,
} from "./constants.ts";
import type { RequestStatus } from "./request.ts";

/**
 * How the workflow's walk ended: a verifier's `valid` or `catch_all` on candidate n (n is 0 for a
 * re-verification's address), a re-verification's other verdict, no verifier left, the sources
 * done, or the lookup's own step failed with its code.
 */
export type LookupEnd =
  | { readonly end: "valid" | "catch_all" | "not_verified"; readonly n: number }
  | { readonly end: "no_verifier" | "exhausted" }
  | { readonly end: "failed"; readonly code: string };
/**
 * What the settle found when it read the valid candidate: free, another person's, a bounced one, or
 * one an active never-contact entry on every channel or on email holds (contacts' recordPersonEmail,
 * gamma-rf-040).
 */
export type Holder = "free" | "other_person" | "inactive" | "suppressed";
export type Settlement = {
  readonly status: RequestStatus;
  readonly reason: MissingReason | null;
  readonly errorCode: string | null;
  /** The cache entry written for the person's key, the other kind's deleted; null, none. */
  readonly cache: "email" | "negative" | null;
  /** The company domain recorded catch-all for every workspace. */
  readonly domainStatus: boolean;
  readonly credits: "commit" | "release" | "none";
  readonly event: "enrichment.address_verified" | "enrichment.address_missing";
};

/** A verified address kept: the email entry renewed, the credits committed unless free. */
const verified = (credits: Settlement["credits"]): Settlement => ({
  status: "found",
  reason: null,
  errorCode: null,
  cache: "email",
  domainStatus: false,
  credits,
  event: "enrichment.address_verified",
});
const missing = (
  status: RequestStatus,
  reason: MissingReason,
  rows: Partial<Settlement> = {},
): Settlement => ({
  status,
  reason,
  errorCode: null,
  cache: null,
  domainStatus: false,
  credits: "release",
  event: "enrichment.address_missing",
  ...rows,
});

/** The verdict a verify step recorded, or undefined for its other outcomes. */
export const verdictOf = (outcome: string): Verdict | undefined =>
  (VERDICTS as readonly string[]).includes(outcome) ? (outcome as Verdict) : undefined;

/**
 * Why a lookup whose sources are done found nothing, from its steps: a candidate a verifier or its
 * finder judged, one off the company's domain, a personal one waiting for consent, a source that
 * answered; none answered (each failed or out of calls), the provider error with the last code.
 */
export function exhaustedReason(tried: readonly TriedEntry[]): {
  reason: MissingReason;
  code: string | null;
} {
  const has = (step: TriedEntry["step"], test: (outcome: string) => boolean) =>
    tried.some((entry) => entry.step === step && test(entry.outcome));
  const verified = has("verify", (outcome) => verdictOf(outcome) !== undefined);
  if (verified || has("candidate", (outcome) => outcome === "vendor_invalid")) {
    return { reason: "not_verified", code: null };
  }
  if (has("candidate", (outcome) => outcome === "other_domain")) {
    return { reason: "other_domain", code: null };
  }
  if (has("candidate", (outcome) => outcome === "personal_needs_consent")) {
    return { reason: "personal_needs_consent", code: null };
  }
  const answered = (outcome: string) => outcome !== "failed" && outcome !== "allowance_spent";
  if (has("find", answered)) return { reason: "no_result", code: null };
  const failures = tried.filter((entry) => entry.step === "find" && entry.code !== null);
  return { reason: "provider_error", code: failures.at(-1)?.code ?? null };
}

/**
 * A lookup's settlement (jit_step, request): reserved at its start, so committed or released.
 * `given`: the valid address came from a source with `anyDomain`, what the lead gave, which is free
 * (gamma-en-100): released, never committed.
 */
export function lookupSettlement(
  ended: LookupEnd,
  tried: readonly TriedEntry[],
  holder: Holder,
  given = false,
): Settlement {
  switch (ended.end) {
    case "valid":
      if (holder === "other_person") {
        return missing("not_found", "held_by_other_person", { cache: "negative" });
      }
      // A blocked address: nothing kept, no cache entry of it, the credits released (gamma-rf-040).
      if (holder === "suppressed") return missing("skipped_suppressed", "suppressed");
      if (holder === "inactive") return missing("not_found", "bounced", { cache: "negative" });
      return verified(given ? "release" : "commit");
    case "catch_all":
      return missing("not_found", "catch_all", { cache: "negative", domainStatus: true });
    case "not_verified":
      return missing("not_found", "not_verified", { cache: "negative" });
    case "no_verifier":
      return missing("waiting_allowance", "no_verifier_left");
    case "failed":
      return missing("failed", "provider_error", { errorCode: ended.code });
    case "exhausted": {
      const { reason, code } = exhaustedReason(tried);
      if (reason === "provider_error") return missing("failed", reason, { errorCode: code });
      const cache = reason === "personal_needs_consent" ? null : "negative";
      return missing("not_found", reason, { cache });
    }
  }
}

/** The reason a running request keeps for its settle: a lookup of the lead's own sources; else null. */
export const ownSourcesReasonOf = (reason: string | null): OwnSourcesReason | null =>
  (OWN_SOURCES_REASONS as readonly (string | null)[]).includes(reason)
    ? (reason as OwnSourcesReason)
    : null;

/**
 * A lookup of the lead's own sources (gamma-en-100): nothing reserved, so nothing committed (any
 * reservation released). A verifier's `valid` on an address no other person holds keeps it, and on a
 * blocked one ends skipped_suppressed (gamma-rf-040); any other end is the plan's own, as the
 * prepare would have ended it before: `waiting_budget` for `insufficient_credits`, else
 * `not_found`, with no cache entry. A `catch_all` on a work address still records the company's
 * domain.
 */
export function ownSourcesSettlement(
  ended: LookupEnd,
  holder: Holder,
  reason: OwnSourcesReason,
): Settlement {
  if (ended.end === "valid" && holder === "free") return verified("release");
  if (ended.end === "valid" && holder === "suppressed") {
    return missing("skipped_suppressed", "suppressed");
  }
  const status = reason === "insufficient_credits" ? "waiting_budget" : "not_found";
  return missing(status, reason, { domainStatus: ended.end === "catch_all" });
}

/**
 * A re-verification's settlement: free, so nothing reserved; `valid` renews the address, any other
 * verdict changes it and leaves a negative entry, the domain recorded catch-all for a work address.
 */
export function reverifySettlement(ended: LookupEnd, personal: boolean): Settlement {
  const free = { credits: "none" } as const;
  switch (ended.end) {
    case "valid":
      return verified("none");
    case "catch_all":
      return missing("not_found", "catch_all", {
        ...free,
        cache: "negative",
        domainStatus: !personal,
      });
    case "not_verified":
      return missing("not_found", "not_verified", { ...free, cache: "negative" });
    case "no_verifier":
      return missing("waiting_allowance", "no_verifier_left", free);
    case "failed":
      return missing("failed", "provider_error", { ...free, errorCode: ended.code });
    case "exhausted":
      return missing("failed", "provider_error", free);
  }
}
