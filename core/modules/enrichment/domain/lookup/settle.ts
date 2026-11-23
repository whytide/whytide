// The lookup's settle (docs/flows.md "The settle"), one tenant run under the request's lock, then the
// lookup's raw/ files deleted once it committed: the outcome tables of outcome.ts written. A valid
// candidate becomes a contact point unless another person holds its address, or the never-contact
// list does, which ends the lookup skipped_suppressed (gamma-rf-040); the person's key gets
// its cache entry; a work address's domain found catch-all is recorded for every workspace; the
// credits are committed for a kept address and released otherwise; the event is published in the
// same run. A request settled already, or erased, is left as it is: the same request settled twice
// commits once. A re-verification changes its contact point's verification, never its address. A new
// work address kept at the company's domain counts for the domain's pattern (gamma-en-085,
// gamma-rf-030). An address from a source with anyDomain, what the lead gave, commits nothing; a
// lookup of the lead's own sources commits nothing and, with nothing kept, ends with its plan's reason
// (gamma-en-100). The address a page printed with the person (gamma-wr-070) is emptied from the
// request when it ends, with the other columns.
import { getCompany, getPerson } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { credits } from "@whytide/platform";
import { now } from "../clock.ts";
import { writeCatchAll, writePattern } from "../email/domain-pattern.ts";
import { countedPattern } from "../email/patterns.ts";
import { definedEmailSource } from "../sources/define.ts";
import { EMAIL_KINDS, type TriedEntry } from "./constants.ts";
import { type Candidate, deleteCandidates, readCandidate } from "./files.ts";
import type { Runs } from "./find.ts";
import { domainOf, keyHashOf, normalDomain } from "./key.ts";
import {
  type Holder,
  type LookupEnd,
  lookupSettlement,
  ownSourcesReasonOf,
  ownSourcesSettlement,
  reverifySettlement,
  type Settlement,
  verdictOf,
} from "./outcome.ts";
import { keepAddress, writeCache } from "./points.ts";
import { publishEnd } from "./prepare.ts";
import { lockedRequest, type RequestRow, type RequestStatus, triedEntries } from "./request.ts";

/** The provider a negative entry names when no step named one. */
const NO_PROVIDER = "enrichment";

export async function settleLookupRun(
  runs: Runs,
  input: { requestId: string; ended: LookupEnd },
): Promise<{ status: RequestStatus }> {
  const { requestId } = input;
  let { ended } = input;
  let candidate: Candidate | null = null;
  if (ended.end === "valid" || ended.end === "catch_all") {
    if (ended.n > 0) {
      candidate = await readCandidate(runs.workspaceId, requestId, ended.n);
      // Only a verifier's valid keeps an address, whatever the workflow says.
      if (ended.end === "valid" && candidate.verdict !== "valid") {
        ended = { end: "failed", code: "enrichment_file_invalid" };
      }
    }
  }
  const settled = await runs.tenant(() => settle(requestId, ended, candidate));
  if (settled.status !== "running") await deleteCandidates(runs.workspaceId, requestId);
  return settled;
}

async function settle(
  requestId: string,
  ended: LookupEnd,
  candidate: Candidate | null,
): Promise<{ status: RequestStatus }> {
  const request = await lockedRequest(requestId);
  if (request === null) return { status: "not_found" };
  if (request.status !== "running") {
    // A request settled before it ran (cancelled while queued, a prepare that failed) keeps no
    // address either: the column is emptied at every end, whatever the state.
    if (request.printedAddress !== null) {
      await tenantClient.enrichmentRequest.update({
        where: { id: request.id },
        data: { printedAddress: null, updatedAt: now() },
      });
    }
    return { status: request.status };
  }
  const at = now();
  const tried = triedEntries(request.providersTried);
  const person = await getPerson(request.personId);
  const company = person.companyId === null ? null : await getCompany(person.companyId);
  const domain = normalDomain(company?.domain);
  const [first, last] = [person.firstName?.trim() ?? "", person.lastName?.trim() ?? ""];
  const keyHash = first && last && domain ? keyHashOf(first, last, domain) : null;
  let settlement: Settlement;
  let contactPointId: string | null = null;
  // Whether the settle made the contact point: only a new address counts for its pattern.
  let created: boolean | undefined;
  let address: string | null = null;
  // The address the last verdict was on: the candidate's, or the re-verified contact point's.
  let checked = candidate?.address ?? null;
  let provider = lastProvider(tried);
  if (request.trigger === "reverify") {
    // An address only: a phone is never re-verified (gamma-wr-100).
    const point = await tenantClient.contactPoint.findFirst({
      where: { id: request.contactPointId ?? "", kind: { in: [...EMAIL_KINDS] } },
    });
    checked = point?.value ?? null;
    settlement = reverifySettlement(ended, point?.kind === "personal_email");
    const verdict = verdictOf(
      tried.filter((entry) => entry.step === "verify").at(-1)?.outcome ?? "",
    );
    if (point !== null && verdict !== undefined && settlement.status !== "failed") {
      await tenantClient.contactPoint.update({
        where: { id: point.id },
        data: { verification: verdict, verifiedAt: at, updatedAt: at },
      });
      address = point.value;
      provider = point.provider;
      if (settlement.status === "found") contactPointId = point.id;
    }
  } else {
    let holder: Holder = "free";
    if (ended.end === "valid" && candidate !== null) {
      const { sourceClass } = candidate;
      ({ holder, contactPointId, created } = await keepAddress(request.personId, {
        address: candidate.address,
        kind: candidate.kind,
        sourceClass,
        provider: candidate.provider,
        verifiedAt: at,
      }));
      address = candidate.address;
      provider = candidate.provider;
    }
    const own = ownSourcesReasonOf(request.reason);
    // What the lead gave is free: a source with anyDomain proposed it (gamma-en-100).
    const given = candidate !== null && definedEmailSource(candidate.source)?.anyDomain === true;
    settlement =
      own === null
        ? lookupSettlement(ended, tried, holder, given)
        : ownSourcesSettlement(ended, holder, own);
  }
  // A catch-all verdict marks the company's own domain only: never a former employer's, held from
  // an earlier company, nor a subdomain, which the next lookup's check does not read.
  const catchAll =
    checked !== null && domain !== "" && domainOf(checked) === domain ? domain : null;
  await writeRows(request, settlement, { keyHash, address, provider, catchAll, at });
  // A new work address kept at the company's own domain counts for its pattern (gamma-rf-030): the
  // next lead there gets the most proven pattern first. A renewed one or a re-verification counts none.
  const counted =
    settlement.status === "found" && candidate !== null
      ? countedPattern({ ...candidate, created: created === true }, domain, first, last)
      : null;
  if (counted !== null) await writePattern(domain, counted, "verified", at);
  let creditsCharged = "0";
  if (request.creditUsageId !== null && settlement.credits === "commit") {
    creditsCharged = (await credits.commit(request.creditUsageId)).credits;
  } else if (request.creditUsageId !== null && settlement.credits === "release") {
    await credits.release(request.creditUsageId);
  }
  const { status, reason, errorCode } = settlement;
  await tenantClient.enrichmentRequest.update({
    where: { id: request.id },
    data: {
      status,
      reason,
      errorCode,
      contactPointId,
      creditsCharged,
      printedAddress: null,
      finishedAt: at,
      updatedAt: at,
    },
  });
  await publishEnd(request, { reason, contactPointId });
  return { status };
}

/** The cache entry of the person's key, and the company's domain found catch-all. */
async function writeRows(
  request: RequestRow,
  settlement: Settlement,
  rows: {
    keyHash: string | null;
    address: string | null;
    provider: string;
    catchAll: string | null;
    at: Date;
  },
): Promise<void> {
  const { keyHash, address, provider, catchAll: domain, at } = rows;
  const { personId } = request;
  if (keyHash !== null && settlement.cache === "email" && address !== null) {
    await writeCache({ kind: "email", personId, keyHash, provider, at, address });
  }
  if (keyHash !== null && settlement.cache === "negative") {
    const reason = settlement.reason ?? "not_verified";
    await writeCache({ kind: "negative", personId, keyHash, provider, at, reason });
  }
  if (settlement.domainStatus && domain !== null) await writeCatchAll(domain, provider, at);
}

/** The adapter of the last step that answered, as the cache names its provider. */
function lastProvider(tried: readonly TriedEntry[]): string {
  const source = tried.filter((entry) => entry.outcome !== "failed").at(-1)?.source;
  return source?.split("/").at(-1) ?? NO_PROVIDER;
}
