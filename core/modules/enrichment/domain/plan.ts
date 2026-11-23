// A run's plan and its pass (README "How it works", docs/flows.md), pure, so that the workflow walks
// the pass in its sandbox: the fields a run wants, why it skips the company, and the next source to
// ask. The next source is the first in the plan's order not asked yet that has one of its inputs and
// fills a field still wanted, looked for from the top every time: a source that adds an input (a
// domain, a LinkedIn page) restarts the pass, and an earlier source that lacked it runs then, once.
import {
  ANSWERED,
  COMPANY_FIELDS,
  type CompanyField,
  DAY_MS,
  FACT_FIELDS,
  type Field,
  type Input,
  KEY_FIELDS,
  MEMBER_SOURCE,
  type Outcome,
  PERSON_FIELDS,
  type PersonField,
  type SkipReason,
} from "./constants.ts";

/** One source of a run's plan: names and kinds, never a value. */
export type PlanEntry = {
  readonly source: string;
  readonly activityKind: "provider" | "ai" | "db";
  readonly needs: readonly Input[];
  readonly fills: readonly Field[];
  readonly timeoutSeconds: number;
};
/** The sources in order, the fields wanted and the inputs the run has at its start. */
export type Plan = {
  readonly sources: readonly PlanEntry[];
  readonly wanted: readonly Field[];
  readonly have: readonly Input[];
};
/** One source asked, as sources_tried keeps it: names, an outcome, a code, a duration. */
export type SourceTried = {
  readonly source: string;
  readonly outcome: Outcome;
  readonly code: string | null;
  readonly filled: readonly Field[];
  readonly ms: number;
};
/** sources_tried as stored: its jsonb, written only as SourceTried entries (runs.ts). */
export const triedOf = (stored: unknown): SourceTried[] =>
  Array.isArray(stored) ? (stored as SourceTried[]) : [];
/** A finished run of the company, as the retry rule reads it. */
export type CompanyRun = {
  readonly wanted: readonly string[];
  readonly tried: readonly SourceTried[];
};

const empty = (value: unknown) => value === null || value === undefined || value === "";
/** A record's provenance by column, as contacts keeps it: the class and the time are read. */
type Stamped = {
  readonly fieldProvenance: Readonly<
    Record<string, { readonly source: string; readonly at: string }>
  >;
};
/** The column is empty and no member set or cleared it: a source may fill it. */
const fillable = (record: Stamped, column: string, value: unknown) =>
  empty(value) && record.fieldProvenance[column]?.source !== MEMBER_SOURCE;

/** What makes a fact old: the time the run starts and ENRICHMENT_FACT_DAYS, 0 for never. */
export type FactAge = { readonly at: Date; readonly days: number };

/**
 * A fact a source stamped more than `days` before `at` (gamma-rf-020): the age is the stamp's,
 * whatever its source. Never a key, a member's value, a value with no stamp, nor any with `days` 0.
 */
export function oldFact(record: Stamped, field: CompanyField, age: FactAge): boolean {
  const stamp = record.fieldProvenance[field];
  if (age.days === 0 || !FACT_FIELDS.includes(field) || stamp === undefined) return false;
  if (stamp.source === MEMBER_SOURCE) return false;
  return age.at.getTime() - Date.parse(stamp.at) > age.days * DAY_MS;
}

/**
 * The company's fields a source may fill: every one when the person has no company yet; else the
 * empty ones and the old facts (oldFact), never one a member set or cleared.
 */
export function companyWanted(
  company: ({ readonly [F in CompanyField]: unknown } & Stamped) | null,
  age: FactAge,
): CompanyField[] {
  return COMPANY_FIELDS.filter(
    (field) =>
      company === null || fillable(company, field, company[field]) || oldFact(company, field, age),
  );
}

/** The person's fields a source may fill that a person source of the run fills. */
export function personWanted(
  person: { readonly locationCountry: string | null } & Stamped,
  fills: readonly Field[],
): PersonField[] {
  const open: Record<PersonField, boolean> = {
    "person.country": fillable(person, "locationCountry", person.locationCountry),
  };
  return PERSON_FIELDS.filter((field) => open[field] && fills.includes(field));
}

/** The inputs a run starts with: the company's page, domain and name, the person's location. */
export function inputsOf(
  company: { readonly linkedinUrl: string | null; readonly domain: string | null } | null,
  person: { readonly companyName: string | null; readonly locationText: string | null },
  name: boolean,
): Input[] {
  const given: Record<Input, boolean> = {
    linkedinUrl: !empty(company?.linkedinUrl),
    domain: !empty(company?.domain),
    name,
    locationText: !empty(person.locationText),
  };
  return (Object.keys(given) as Input[]).filter((input) => given[input]);
}

/** A run tried the company when a source answered it: one where every source failed tried nothing. */
export const triedCompany = (run: CompanyRun): boolean =>
  run.tried.some((entry) => ANSWERED.includes(entry.outcome));

/**
 * Why the run does not ask for the company, or null: no company and no company name; a new lead's
 * company tried within the retry days for every field wanted now (`recent`, the runs finished in
 * them); another run working on it.
 */
export function companySkip(input: {
  readonly company: boolean;
  readonly companyName: boolean;
  readonly trigger: "new_lead" | "request";
  readonly wanted: readonly CompanyField[];
  readonly recent: readonly CompanyRun[];
  readonly running: boolean;
}): SkipReason | null {
  if (!input.company && !input.companyName) return "no_company";
  const covers = (run: CompanyRun) => input.wanted.every((field) => run.wanted.includes(field));
  const recently = input.recent.some((run) => triedCompany(run) && covers(run));
  if (input.trigger === "new_lead" && recently) return "enriched_recently";
  return input.running ? "company_running" : null;
}

/** The next source of the pass, or undefined when none is left to ask. */
export function nextSource(
  plan: Plan,
  asked: ReadonlySet<string>,
  have: ReadonlySet<Input>,
  open: ReadonlySet<Field>,
): PlanEntry | undefined {
  return plan.sources.find(
    (entry) =>
      !asked.has(entry.source) &&
      entry.needs.some((input) => have.has(input)) &&
      entry.fills.some((field) => open.has(field)),
  );
}

/** The inputs that filled fields add: a domain and a LinkedIn page are inputs too. */
export const inputsAdded = (filled: readonly Field[]): Input[] =>
  filled.filter((field) => KEY_FIELDS.includes(field)) as Input[];
