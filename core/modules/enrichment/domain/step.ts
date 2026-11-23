// One source asked for one run (README "How it works", docs/flows.md "The pass"): its input read in a
// run of its own, its call counted (usage.ts), the source called with the minimum input and the
// run's ids outside any run, with a way to open one for its own reads, then its facts written for the
// wanted fields still empty or old (gamma-rf-020), through contacts, with its outcome recorded in the
// same run. Whatever the source fails with is recorded and never raised: its code, never its message
// or a value, with one warning; a vendor's spent allowance marks the period spent. A source's own
// word for a skip is its outcome, and the provider it names stamps its facts; an answer off those
// rules is a failure, enrichment_source_invalid. A write that a company's key refuses (another
// company of the workspace has it, contacts refuses its form) is made again without that key. A late
// answer, past the step's timeout, writes nothing once the source is recorded or the run ended; a run
// that privacy's eraser deleted under way asks nothing and records nothing. The answer is field names
// and a boolean.
import {
  type CompanyProfile,
  getCompany,
  getPerson,
  linkPersonToCompany,
  recordPersonCountry,
  upsertCompany,
  type WorkspaceCompany,
} from "@whytide/contacts";
import { Prisma } from "@whytide/db";
import { isAppError } from "@whytide/platform";
import { ADAPTER_NAME } from "@whytide/providers";
import { errors } from "../errors.ts";
import { settings } from "../settings.ts";
import { now } from "./clock.ts";
import {
  ACTIVITY_FAILED,
  CODE,
  COMPANY_FIELDS,
  type CompanyField,
  type Field,
  NOT_FOUND,
  type Outcome,
  SOURCE_UNKNOWN,
  STEP_OUTCOMES,
} from "./constants.ts";
import { log } from "./log.ts";
import { inputsAdded, oldFact, triedOf } from "./plan.ts";
import { keptRun, lockedRun, recordTried } from "./runs.ts";
import type { SourceAnswer, SourceDefinition, SourceFacts, SourceInput } from "./sources/define.ts";
import { sourceNamed } from "./sources/index.ts";
import { markSpent, reserveCall } from "./usage.ts";

/** What the workflow learns of one source: the outcome, the fields filled, whether an input came. */
export type StepResult = {
  readonly outcome: Outcome;
  readonly filled: readonly Field[];
  readonly inputsAdded: boolean;
};
/** The step's runs: an activity's context.tenant; its heartbeat, for an `ai` source. */
type Runs = { tenant<T>(fn: () => Promise<T>): Promise<T>; readonly beat?: () => void };
type Written = { outcome: Outcome; filled: Field[]; companyId?: string };
type Stamp = SourceDefinition["provenance"];
/** What a write that does not happen answers: nothing filled; no record follows it. */
const NOTHING: Written = { outcome: NOT_FOUND, filled: [] };

/** A stamp older than any stored one: upsertCompany then changes nothing of a company that exists. */
const LOCATE = new Date(0);
const KEYS = ["linkedinUrl", "domain"] as const;
const REFUSED_KEY = new Set(["linkedin_url_invalid", "contacts_input_invalid"]);

/** An error's code as the run keeps it; another text, `fallback`. */
export function codeOf(error: unknown, fallback = ACTIVITY_FAILED): string {
  return isAppError(error) && CODE.test(error.code) ? error.code : fallback;
}

export async function askSource(
  runs: Runs,
  input: { runId: string; source: string },
): Promise<StepResult> {
  const { runId, source: name } = input;
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const result = ({ outcome, filled }: Written): StepResult => ({
    outcome,
    filled,
    inputsAdded: inputsAdded(filled).length > 0,
  });
  const record = async (outcome: Outcome, code: string | null) => {
    const entry = { source: name, outcome, code, filled: [], ms: ms() };
    await runs.tenant(() => recordTried(runId, entry));
    return result({ outcome, filled: [] });
  };
  const fail = (code: string) => {
    log().warn({ provider: name, code }, "enrichment: a source failed; the next one is asked");
    return record("failed", code);
  };
  const source = await sourceNamed(name);
  if (source === undefined) return fail(SOURCE_UNKNOWN);
  const asked = await runs.tenant(() => inputOf(runId, source));
  // Erased under way: no call counted or made, nothing recorded.
  if (asked === null) return result(NOTHING);
  const allowance = source.allowance?.() ?? null;
  if (!(await reserveCall(name, allowance))) return record("allowance_spent", null);
  let answer: SourceAnswer;
  try {
    const beat = runs.beat;
    answer = await source.run(asked, { tenant: (fn) => runs.tenant(fn), ...(beat && { beat }) });
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
  const stamp = { ...source.provenance, provider: answer.provider ?? source.provenance.provider };
  if (!ADAPTER_NAME.test(stamp.provider)) return fail(errors.enrichment_source_invalid);
  let refused: unknown;
  for (const given of withoutKeys(answer.facts)) {
    try {
      const written = await runs.tenant(async () => {
        const done = await writeFacts(runId, source, given, stamp);
        const entry = { source: name, outcome: done.outcome, code: null, filled: done.filled };
        await recordTried(runId, { ...entry, ms: ms() }, done.companyId);
        return done;
      });
      return result(written);
    } catch (error) {
      refused = error;
      const taken = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (!taken && !(isAppError(error) && REFUSED_KEY.has(error.code))) break;
    }
  }
  return fail(codeOf(refused));
}

/**
 * The minimum input: the company's keys and country for a company source, the location for a
 * person's, with the run's workspace and the person's company; none for a run erased under way.
 */
async function inputOf(runId: string, source: SourceDefinition): Promise<SourceInput | null> {
  const run = await keptRun(runId);
  if (run === null) return null;
  const wanted = (run.wanted as Field[]).filter(
    (field) => !run.filled.includes(field) && source.fills.includes(field),
  );
  const person = await getPerson(run.personId);
  const ids = { workspaceId: run.workspaceId, companyId: person.companyId };
  if (source.kind === "person") {
    return { ...ids, person: given({ locationText: person.locationText }), wanted };
  }
  if (person.companyId === null) {
    return { ...ids, company: given({ name: person.companyName }), wanted };
  }
  const { linkedinUrl, domain, name, country } = await getCompany(person.companyId);
  return { ...ids, company: given({ linkedinUrl, domain, name, country }), wanted };
}

/**
 * The facts for the run's open fields that are empty or old (oldFact, gamma-rf-020), written with
 * `stamp`, the source's class and the provider that answered, at the step's time: contacts replaces
 * an old value and its stamp on the layer the class goes to, never a member's. A person with only a
 * company name gets the company of a page or a domain the source brought, made or found by that key,
 * and is linked to it first; with neither, nothing is written. Filled: the run's open fields no
 * longer empty, and the old facts written, whose stamp the write changed. Under the run's lock: a run
 * gone or ended takes nothing, and one with this source recorded already (a late answer past the
 * step's timeout, a db step tried again) keeps that record and answers it.
 */
async function writeFacts(
  runId: string,
  source: SourceDefinition,
  facts: SourceFacts,
  stamp: Stamp,
): Promise<Written> {
  const run = await lockedRun(runId);
  if (run === null || run.status !== "running") return NOTHING;
  const recorded = triedOf(run.sourcesTried).find((entry) => entry.source === source.name);
  if (recorded !== undefined) return { outcome: recorded.outcome, filled: [...recorded.filled] };
  const open = (run.wanted as Field[]).filter((field) => !run.filled.includes(field));
  const person = await getPerson(run.personId);
  const at = now();
  if (source.kind === "person") {
    const country = facts["person.country"];
    if (!open.includes("person.country") || country === undefined || person.locationCountry) {
      return { outcome: "found", filled: [] };
    }
    const stamped = { ...stamp, at };
    const { written } = await recordPersonCountry({ personId: person.id, country, stamp: stamped });
    return { outcome: "found", filled: written ? ["person.country"] : [] };
  }
  const wanted = COMPANY_FIELDS.filter((field) => open.includes(field));
  const brought = wanted.filter((field) => has(facts, field));
  const before = person.companyId === null ? null : await getCompany(person.companyId);
  let base: WorkspaceCompany;
  let made = false;
  if (before !== null) base = before;
  else {
    const keys = pick(
      facts,
      KEYS.filter((key) => brought.includes(key)),
    );
    if (keys.linkedinUrl === undefined && keys.domain === undefined) {
      return { outcome: "no_company_key", filled: [] };
    }
    const name = person.companyName ?? "";
    const located = await upsertCompany({
      ...stamp,
      company: { name, ...keys, fetchedAt: LOCATE },
    });
    base = located.company;
    made = located.created;
    await linkPersonToCompany({ personId: person.id, companyId: base.id });
  }
  const age = { at, days: settings.ENRICHMENT_FACT_DAYS };
  const writing = brought.filter((field) => empty(base[field]) || oldFact(base, field, age));
  let after = base;
  // A company the locate made has its name and key at the old stamp until this write.
  if (writing.length > 0 || made) {
    const company: CompanyProfile = {
      name: base.name,
      ...given({ linkedinUrl: base.linkedinUrl, domain: base.domain }),
      ...valuesOf(facts, writing),
      fetchedAt: at,
    };
    after = (await upsertCompany({ ...stamp, company })).company;
  }
  const renewed = (field: CompanyField) =>
    writing.includes(field) &&
    after.fieldProvenance[field]?.at !== before?.fieldProvenance[field]?.at;
  const filled = wanted.filter(
    (field) => !empty(after[field]) && (empty(before?.[field]) || renewed(field)),
  );
  return { outcome: "found", filled, ...(before === null && { companyId: base.id }) };
}

/** The facts, then without a LinkedIn page, then without a domain too: the writes to try in turn. */
function withoutKeys(facts: SourceFacts): SourceFacts[] {
  const { linkedinUrl, ...withoutPage } = facts;
  const { domain, ...withoutBoth } = withoutPage;
  return [
    facts,
    ...(linkedinUrl === undefined ? [] : [withoutPage]),
    ...(domain === undefined ? [] : [withoutBoth]),
  ];
}

/** Whether the facts bring the field: the size as a range or as a headcount. */
function has(facts: SourceFacts, field: CompanyField): boolean {
  return field === "sizeRange"
    ? facts.sizeRange !== undefined || facts.employeeCount !== undefined
    : facts[field] !== undefined;
}

/** The facts' values of `fields` as contacts takes them; the headcount goes with the size. */
function valuesOf(facts: SourceFacts, fields: readonly CompanyField[]): Partial<CompanyProfile> {
  const size = fields.includes("sizeRange") ? { employeeCount: facts.employeeCount } : {};
  return given({ ...pick(facts, fields), ...size });
}

function pick<K extends keyof SourceFacts>(facts: SourceFacts, keys: readonly K[]) {
  return given(Object.fromEntries(keys.map((key) => [key, facts[key]]))) as Pick<SourceFacts, K>;
}

/** The values that are set: null, undefined and empty ones left out. */
function given<T extends Record<string, unknown>>(
  values: T,
): { [K in keyof T]?: NonNullable<T[K]> } {
  const kept = Object.entries(values).filter(([, value]) => !empty(value));
  return Object.fromEntries(kept) as { [K in keyof T]?: NonNullable<T[K]> };
}

const empty = (value: unknown) => value === null || value === undefined || value === "";
