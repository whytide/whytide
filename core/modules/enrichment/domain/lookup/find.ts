// The lookup's find step (docs/flows.md "The lookup", step 2), one email source asked: its input read
// in a run of its own, its call counted (../usage.ts), the source called with the first name, last
// name and company domain outside any run, then its candidates decided. A candidate is dropped off
// the address's form, off the company's domain unless the source has anyDomain, at the company's
// domain in a lookup of the lead's own sources for a catch-all domain (gamma-en-100: it could never
// be valid there), seen already in this lookup, judged invalid by its own finder, or a personal
// address of a person whose country needs consent; each kept one goes to its raw/ file. Whatever the source fails with is recorded with
// its code and never raised: the workflow asks the next source. The steps are recorded under the
// request's lock, once per source: a late answer past the step's timeout keeps nothing. Ids, codes
// and the candidates' numbers out. The step `printed` (gamma-wr-070) is no source of the list: it
// proposes the one address a page printed with the person, read from the request, with no outside
// call and no count, at the company's domain only; its candidate goes to the verifiers as any.
import { getCompany, getPerson } from "@whytide/contacts";
import { ADAPTER_NAME, verifyEmailInput } from "@whytide/providers";
import { errors } from "../../errors.ts";
import { settings } from "../../settings.ts";
import { CODE, NOT_FOUND, SOURCE_UNKNOWN, STEP_OUTCOMES } from "../constants.ts";
import { log } from "../log.ts";
import type { EmailSourceDefinition, EmailSourceInput } from "../sources/define.ts";
import { codeOf } from "../step.ts";
import { markSpent, reserveCall } from "../usage.ts";
import { type Drop, KEPT, PRINTED, type TriedEntry } from "./constants.ts";
import { type Candidate, readCandidates, writeCandidate } from "./files.ts";
import { atDomain, kindOf, needsConsent, normalDomain } from "./key.ts";
import { ownSourcesReasonOf } from "./outcome.ts";
import { lockedRequest, recordSteps, triedEntries } from "./request.ts";
import { loadEmail } from "./sources.ts";
import { personalEmailEuUk } from "./switch.ts";

/** An activity's context: the input's workspace and its runs. */
export type Runs = {
  readonly workspaceId: string;
  tenant<T>(fn: () => Promise<T>): Promise<T>;
};
/** What the workflow learns of one source: its outcome and the numbers of the candidates kept. */
export type FindResult = { readonly outcome: string; readonly kept: readonly number[] };
type Asked = {
  readonly input: EmailSourceInput;
  readonly personalNeedsConsent: boolean;
  /** A lookup of the lead's own sources at a company domain recorded catch-all (gamma-en-100). */
  readonly catchAllDomain: boolean;
  /** The address a page printed with the person, held by a lookup `found` while it runs. */
  readonly printedAddress: string | null;
};

/** The step `printed` as the other steps read a source: its provenance, a company domain only. */
const PRINTED_STEP: EmailSourceDefinition = Object.freeze({
  name: PRINTED.name,
  kind: "email",
  activityKind: "db",
  provenance: { source: PRINTED.sourceClass, provider: PRINTED.provider },
  run: async () => ({ found: false as const }),
});

export async function findCandidates(
  runs: Runs,
  input: { requestId: string; source: string },
): Promise<FindResult> {
  const { requestId, source: name } = input;
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const entry = (outcome: string, code: string | null): TriedEntry => ({
    source: name,
    step: "find",
    outcome,
    code,
    ms: ms(),
  });
  const once = { source: name, step: "find" } as const;
  const record = async (outcome: string, code: string | null): Promise<FindResult> => {
    await runs.tenant(() => recordSteps(requestId, [entry(outcome, code)], once));
    return { outcome, kept: [] };
  };
  const fail = (code: string) => {
    log().warn(
      { provider: name, code },
      "enrichment: an email source failed; the next one is asked",
    );
    return record("failed", code);
  };
  const printed = name === PRINTED.name;
  const source = printed
    ? PRINTED_STEP
    : (await loadEmail()).sources.find((loaded) => loaded.name === name);
  if (source === undefined) return fail(SOURCE_UNKNOWN);
  const asked = await runs.tenant(() => inputOf(requestId));
  if (asked === null) return { outcome: NOT_FOUND, kept: [] };
  const allowance = source.allowance?.() ?? null;
  if (!printed && !(await reserveCall(name, allowance))) return record("allowance_spent", null);
  let answer: Awaited<ReturnType<EmailSourceDefinition["run"]>>;
  try {
    answer = printed
      ? printedAnswer(asked.printedAddress)
      : await source.run(asked.input, { tenant: (fn) => runs.tenant(fn) });
  } catch (error) {
    const code = codeOf(error);
    if (!code.endsWith("_allowance_spent")) return fail(code);
    await markSpent(name, allowance);
    return record("allowance_spent", code);
  }
  if (!answer.found) {
    const outcome = answer.outcome ?? NOT_FOUND;
    const own = CODE.test(outcome) && !STEP_OUTCOMES.includes(outcome);
    return own ? record(outcome, null) : fail(errors.enrichment_source_invalid);
  }
  const provider = answer.provider ?? source.provenance.provider;
  if (!ADAPTER_NAME.test(provider)) return fail(errors.enrichment_source_invalid);
  const seen = new Set(
    [...(await readCandidates(runs.workspaceId, requestId)).values()].map((c) => c.address),
  );
  const decided: { outcome: Drop | typeof KEPT; candidate?: Candidate }[] = [];
  for (const proposed of answer.candidates) {
    const address = proposed.address.trim().toLowerCase();
    const drop = dropOf(address, proposed.vendorVerdict, source, asked, seen);
    seen.add(address);
    if (drop !== null) {
      decided.push({ outcome: drop });
      continue;
    }
    const kind = kindOf(address, asked.input.companyDomain);
    const { source: sourceClass } = source.provenance;
    decided.push({
      outcome: KEPT,
      candidate: { address, kind, source: name, sourceClass, provider },
    });
  }
  const entries = [
    entry("found", null),
    ...decided.map(({ outcome }) => ({
      ...entry(outcome, null),
      step: "candidate" as const,
      ms: 0,
    })),
  ];
  const { recorded, before } = await runs.tenant(() => recordSteps(requestId, entries, once));
  if (!recorded) return { outcome: "found", kept: [] };
  let n = before.filter((step) => step.step === "candidate" && step.outcome === KEPT).length;
  const kept: number[] = [];
  for (const { candidate } of decided) {
    if (candidate === undefined) continue;
    n += 1;
    await writeCandidate(runs.workspaceId, requestId, n, candidate);
    kept.push(n);
  }
  return { outcome: "found", kept };
}

/** The one address a page printed, or nothing: no address is held once the request ended. */
const printedAnswer = (
  address: string | null,
): Awaited<ReturnType<EmailSourceDefinition["run"]>> =>
  address === null
    ? { found: false }
    : { found: true, candidates: [{ address }], provider: PRINTED.provider };

/** Why the candidate is dropped before any verifier, or null: it goes to one. */
export function dropOf(
  address: string,
  vendorVerdict: string | undefined,
  source: EmailSourceDefinition,
  asked: Pick<Asked, "personalNeedsConsent" | "catchAllDomain"> & {
    readonly input: Pick<EmailSourceInput, "companyDomain">;
  },
  seen: ReadonlySet<string>,
): Drop | null {
  if (!verifyEmailInput.safeParse({ address }).success) return "address_invalid";
  const atCompany = atDomain(address, asked.input.companyDomain);
  if (!atCompany && source.anyDomain !== true) return "other_domain";
  if (atCompany && asked.catchAllDomain) return "catch_all_domain";
  if (seen.has(address)) return "seen";
  if (vendorVerdict === "invalid") return "vendor_invalid";
  if (!atCompany && asked.personalNeedsConsent) return "personal_needs_consent";
  return null;
}

/** The source's input: the person's names and the company's domain; none once the request ended. */
async function inputOf(requestId: string): Promise<Asked | null> {
  const request = await lockedRequest(requestId);
  if (request === null || request.status !== "running") return null;
  const person = await getPerson(request.personId);
  const company = person.companyId === null ? null : await getCompany(person.companyId);
  // Each candidate kept so far was verified before this source was asked (the workflow's walk).
  const kept = triedEntries(request.providersTried).filter(
    (step) => step.step === "candidate" && step.outcome === KEPT,
  ).length;
  const input = {
    workspaceId: request.workspaceId,
    personId: request.personId,
    firstName: person.firstName?.trim() ?? "",
    lastName: person.lastName?.trim() ?? "",
    companyDomain: normalDomain(company?.domain),
    room: Math.max(0, settings.ENRICHMENT_EMAIL_MAX_CANDIDATES - kept),
  };
  const switchOn = personalEmailEuUk();
  return {
    input,
    personalNeedsConsent: needsConsent(person.locationCountry, switchOn),
    catchAllDomain: ownSourcesReasonOf(request.reason) === "catch_all",
    printedAddress: request.printedAddress,
  };
}
