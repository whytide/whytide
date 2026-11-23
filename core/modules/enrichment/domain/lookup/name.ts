// The work address of a name that is not a person yet (README "The work address of a name",
// docs/flows.md "The lookup for a name"; gamma-wr-080), in the caller's step. A picked person no
// page keyed has only a name, so until an address is `valid` the name lives in this function's
// memory: in no table, request, history, event, `providers_tried`, file, log line or credit key. It
// asks the sources that need no person (`forName`: the pattern's guesses and the finders), in the
// configured order and inside the lookup's bound on candidates; each candidate is dropped as the
// lookup drops one (its form, the company's domain, seen, a finder's own `invalid`) and goes to the
// verifiers in their turns. The gates are the lookup's own: a domain recorded catch-all gets no
// guess, and nothing is asked with no verifier call left or the credits short. Only a verifier's
// `valid` keeps an address, in one tenant run: the caller's function makes the person with the address
// as its key, then the contact point is kept for that person, the cache entry and the pattern's
// count written and the credit committed. An address the never-contact list holds, or another
// person holds, ends the run rolled back, so that nothing is left, and the credit is released at
// every end but the kept address.
import { randomUUID } from "node:crypto";
import { findPersonByEmail } from "@whytide/contacts";
import { AppError, credits, creditsCodes, isAppError } from "@whytide/platform";
import { ADAPTER_NAME } from "@whytide/providers";
import { errors } from "../../errors.ts";
import { prices } from "../../prices.ts";
import { settings } from "../../settings.ts";
import { now } from "../clock.ts";
import { domainStatusOf, writeCatchAll, writePattern } from "../email/domain-pattern.ts";
import { countedPattern } from "../email/patterns.ts";
import { log } from "../log.ts";
import type { EmailSourceDefinition } from "../sources/define.ts";
import { codeOf } from "../step.ts";
import { markSpent, reserveCall } from "../usage.ts";
import { LOOKUP_QUANTITY, type MissingReason, NAME_LOOKUP, type Verdict } from "./constants.ts";
import { dropOf } from "./find.ts";
import { domainOf, keyHashOf, kindOf, normalDomain } from "./key.ts";
import { keepAddress, writeCache } from "./points.ts";
import { loadEmail, type Verifier } from "./sources.ts";
import { verifierOpen } from "./verify.ts";

/** Whom to look for: the names, the company's domain, and the key of the credit (never a name). */
export type NameAsk = {
  readonly firstName: string;
  readonly lastName: string;
  readonly domain: string;
  /** The credit's key: the found company's id and the person's place in the pick, `<id>:<n>`. */
  readonly key: string;
};
/**
 * What the caller gives: its workspace, its way into a tenant run (one per database step, never
 * around a vendor's call), and its function that makes the person with the address as the person's
 * key inside the run it is called in, answering the person's id, or null when it made none.
 */
export type NameDeps = {
  readonly workspaceId: string;
  readonly tenant: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly make: (address: string) => Promise<string | null>;
};
/** Why a name was left without a person. */
export type NameNone = MissingReason | typeof NAME_LOOKUP.notMade;
export type NameResult =
  | { readonly status: "found"; readonly personId: string; readonly contactPointId: string }
  | { readonly status: "none"; readonly reason: NameNone };

/** The end of a run that must leave nothing: thrown inside the tenant run, so that it rolls back. */
class Rollback extends Error {
  readonly reason: NameNone;
  constructor(reason: NameNone) {
    super(reason);
    this.reason = reason;
  }
}

const none = (reason: NameNone): NameResult => ({ status: "none", reason });

/**
 * The person's work address, found for a name: `{ status: "found", personId, contactPointId }` once
 * the caller made the person with a verified address, else `{ status: "none", reason }` with nothing
 * left and the credit released. A failure of the caller's function, or of the credits service, is
 * raised, with the credit released.
 */
export async function workAddressOfName(ask: NameAsk, deps: NameDeps): Promise<NameResult> {
  const subject = NAME_LOOKUP.key.exec(ask.key)?.[1];
  if (subject === undefined) {
    throw new AppError(errors.enrichment_input_invalid, { details: { fields: ["key"] } });
  }
  const names = { firstName: ask.firstName.trim(), lastName: ask.lastName.trim() };
  const domain = normalDomain(ask.domain);
  if (names.firstName === "" || names.lastName === "") return none("no_name");
  if (domain === "") return none("no_domain");
  const loaded = await loadEmail();
  const sources = loaded.sources.filter((source) => source.forName === true);
  const at = now();
  if ((await deps.tenant(() => domainStatusOf(domain, at))).catchAll) return none("catch_all");
  if (sources.length === 0) return none("no_result");
  if (!(await verifierOpen(loaded.verifiers))) return none("no_verifier_left");
  // A part of this call: credits answers the old row for a key, even a released one, so a step run
  // again after a release must not reuse the key. A step run again after a kept address finds the
  // person held and asks nobody, so the part cannot charge twice.
  const attempt = randomUUID().replaceAll("-", "");
  const usageId = await reserve({ key: `${ask.key}:${attempt}`, subject }, deps);
  if (usageId === null) return none("insufficient_credits");
  const release = () => deps.tenant(() => credits.release(usageId));
  let result: NameResult;
  try {
    result = await decide({ ...names, domain, usageId, at }, sources, loaded.verifiers, deps);
  } catch (error) {
    await release();
    throw error;
  }
  if (result.status === "none") await release();
  return result;
}

/** The credit reserved for the key, or null when the workspace's credits are short. */
async function reserve(
  credit: { readonly key: string; readonly subject: string },
  deps: NameDeps,
): Promise<string | null> {
  try {
    const { usageId } = await deps.tenant(() =>
      credits.reserve({
        workspaceId: deps.workspaceId,
        action: prices["enrichment.work_email"],
        quantity: LOOKUP_QUANTITY,
        idempotencyKey: `${NAME_LOOKUP.reservationPrefix}:${credit.key}`,
        subjectRef: credit.subject,
        lease: "async",
      }),
    );
    return usageId;
  } catch (error) {
    if (isAppError(error) && error.code === creditsCodes.insufficient_credits) return null;
    throw error;
  }
}

type Names = {
  readonly firstName: string;
  readonly lastName: string;
  readonly domain: string;
  readonly usageId: string;
  readonly at: Date;
};
/** A candidate a verifier called valid: the address, who proposed it and who said so. */
type Valid = {
  readonly address: string;
  readonly sourceClass: string;
  readonly provider: string;
  readonly verifier: string;
};

async function decide(
  names: Names,
  sources: readonly EmailSourceDefinition[],
  verifiers: readonly Verifier[],
  deps: NameDeps,
): Promise<NameResult> {
  const walked = await walk(names, sources, verifiers, deps);
  if (walked.reason !== undefined) return none(walked.reason);
  try {
    return await deps.tenant(() => keep(names, walked.valid, deps));
  } catch (error) {
    if (error instanceof Rollback) return none(error.reason);
    throw error;
  }
}

/** The sources in order, each new candidate verified, until a `valid` or an end. */
async function walk(
  names: Names,
  sources: readonly EmailSourceDefinition[],
  verifiers: readonly Verifier[],
  deps: NameDeps,
): Promise<{ valid: Valid; reason?: undefined } | { valid?: undefined; reason: NameNone }> {
  const { firstName, lastName, domain } = names;
  const seen = new Set<string>();
  const drops = new Set<string>();
  let verified = 0;
  let answered = false;
  let failed = false;
  for (const source of sources) {
    const room = settings.ENRICHMENT_EMAIL_MAX_CANDIDATES - verified;
    if (room <= 0) break;
    const allowance = source.allowance?.() ?? null;
    if (!(await reserveCall(source.name, allowance))) continue;
    let answer: Awaited<ReturnType<EmailSourceDefinition["run"]>>;
    try {
      const input = { workspaceId: deps.workspaceId, personId: "", firstName, lastName };
      answer = await source.run(
        { ...input, companyDomain: domain, room },
        { tenant: (fn) => deps.tenant(fn) },
      );
    } catch (error) {
      const code = codeOf(error);
      if (code.endsWith("_allowance_spent")) await markSpent(source.name, allowance);
      else failed = true;
      log().warn({ provider: source.name, code }, "enrichment: a source failed; the next is asked");
      continue;
    }
    if (!answer.found) {
      answered = true;
      continue;
    }
    const provider = answer.provider ?? source.provenance.provider;
    if (!ADAPTER_NAME.test(provider)) {
      failed = true;
      continue;
    }
    answered = true;
    for (const proposed of answer.candidates) {
      const address = proposed.address.trim().toLowerCase();
      const asked = { input: { companyDomain: domain }, personalNeedsConsent: false } as const;
      const drop = dropOf(
        address,
        proposed.vendorVerdict,
        source,
        { ...asked, catchAllDomain: false },
        seen,
      );
      seen.add(address);
      if (drop !== null) {
        drops.add(drop);
        continue;
      }
      if (verified >= settings.ENRICHMENT_EMAIL_MAX_CANDIDATES) break;
      const turn = await verdictOf(address, verifiers);
      if ("end" in turn) return { reason: turn.end };
      if (turn.verdict === "valid") {
        const { source: sourceClass } = source.provenance;
        return { valid: { address, sourceClass, provider, verifier: turn.verifier } };
      }
      if (turn.verdict === "catch_all") {
        // The company's own domain only, as the settle records it: never a subdomain's.
        if (domainOf(address) === domain) {
          await deps.tenant(() => writeCatchAll(domain, turn.verifier, names.at));
        }
        return { reason: "catch_all" };
      }
      verified += 1;
    }
  }
  if (verified > 0 || drops.has("vendor_invalid")) return { reason: "not_verified" };
  if (drops.has("other_domain")) return { reason: "other_domain" };
  return { reason: answered || !failed ? "no_result" : "provider_error" };
}

/**
 * The verifiers' turns on one address: the first verdict, or why there is none: every verifier
 * without a call left, or failing.
 */
async function verdictOf(
  address: string,
  verifiers: readonly Verifier[],
): Promise<
  | { readonly verdict: Verdict; readonly verifier: string }
  | { readonly end: "no_verifier_left" | "provider_error" }
> {
  let spent = verifiers.length === 0;
  for (const { name, adapter } of verifiers) {
    if (!(await reserveCall(name, adapter.allowance))) {
      spent = true;
      continue;
    }
    try {
      // The port refuses capitals: an address is kept lower case, and checked so.
      const { verdict } = await adapter.verifyEmail({ address });
      return { verdict, verifier: name.split("/").at(-1) ?? name };
    } catch (error) {
      const code = codeOf(error);
      if (code.endsWith("_allowance_spent")) {
        await markSpent(name, adapter.allowance);
        spent = true;
      }
      log().warn({ provider: name, code }, "enrichment: a verifier failed; the next one is asked");
    }
  }
  return { end: spent ? "no_verifier_left" : "provider_error" };
}

/**
 * The verified address kept, in the caller's tenant run: the person made by the caller's function with
 * the address as key, the contact point kept for them, the cache entry and the pattern's count
 * written, the credit committed. Any end that keeps nothing throws Rollback, so that the person, the
 * lead and every hash made in this run are gone.
 */
async function keep(names: Names, valid: Valid, deps: NameDeps): Promise<NameResult> {
  const { firstName, lastName, domain, usageId, at } = names;
  const { address, sourceClass, provider, verifier } = valid;
  if ((await findPersonByEmail(address)) !== null) throw new Rollback("held_by_other_person");
  const personId = await deps.make(address);
  if (personId === null) throw new Rollback(NAME_LOOKUP.notMade);
  const kind = kindOf(address, domain);
  const kept = await keepAddress(personId, {
    address,
    kind,
    sourceClass,
    provider,
    verifiedAt: at,
  });
  if (kept.contactPointId === null) {
    if (kept.holder === "suppressed") throw new Rollback("suppressed");
    throw new Rollback(kept.holder === "other_person" ? "held_by_other_person" : "bounced");
  }
  const keyHash = keyHashOf(firstName, lastName, domain);
  await writeCache({ kind: "email", personId, keyHash, provider: verifier, at, address });
  const created = kept.created === true;
  const counted = countedPattern({ address, kind, created }, domain, firstName, lastName);
  if (counted !== null) await writePattern(domain, counted, "verified", at);
  await credits.commit(usageId);
  return { status: "found", personId, contactPointId: kept.contactPointId };
}
