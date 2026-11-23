// The lead page's company facts and its "Enrich now" (gamma-en-055; README "The lead page"), in the
// caller's tenant run: the person's company fields and country, read through contacts, each with the
// class and the time of its provenance, never the provider that stamped it (RB-7.3.2); the person's
// last run; and a run on request, answered with its status.
import {
  errors as contactsErrors,
  getCompany,
  getPerson,
  type Person,
  type ProvenanceMap,
} from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError, isAppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { type LastRun, lastRunOf, sourcesTried } from "../readers.ts";
import { requestEnrichment } from "../request.ts";
import { PANEL_FIELDS, type PanelField, PERSON_COUNTRY_FIELD } from "./constants.ts";

/** A value as the panel shows it: null for an empty field, with no class and no time. */
export type Shown<V> = {
  readonly value: V | null;
  /** contacts' source class (`open_data`, `member`…), never a provider's name. */
  readonly sourceClass: string | null;
  readonly at: string | null;
};
export type LeadEnrichment = {
  readonly company: {
    readonly name: string;
    readonly fields: readonly (Shown<string | number> & { readonly field: PanelField })[];
  } | null;
  readonly person: { readonly country: Shown<string> | null };
  /**
   * The person's latest run, and what its sources answered: each outcome once, in the order first
   * answered (`found`, `not_found`, `ambiguous`…), never a source's name.
   */
  readonly lastRun: (LastRun & { readonly outcomes: readonly string[] }) | null;
};

/** The value with its provenance's class and time; an empty one with neither. */
function shown<V>(value: V | null, provenance: ProvenanceMap, field: string): Shown<V> {
  if (value === null || value === "") return { value: null, sourceClass: null, at: null };
  const stamp = provenance[field];
  return { value, sourceClass: stamp?.source ?? null, at: stamp?.at ?? null };
}

/** The person of the workspace; enrichment_person_not_found for none. */
export async function personOf(personId: string): Promise<Person> {
  try {
    return await getPerson(personId);
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) {
      throw new AppError(errors.enrichment_person_not_found);
    }
    throw error;
  }
}

/** The person's company facts, country and last run; enrichment_person_not_found. */
export async function leadEnrichment(personId: string): Promise<LeadEnrichment> {
  const person = await personOf(personId);
  const stored = person.companyId === null ? null : await getCompany(person.companyId);
  const company = stored && {
    name: stored.name,
    fields: PANEL_FIELDS.map((field) => ({
      field,
      ...shown<string | number>(stored[field], stored.fieldProvenance, field),
    })),
  };
  const country = shown(person.locationCountry, person.fieldProvenance, PERSON_COUNTRY_FIELD);
  const last = await lastRunOf(person.id);
  const tried = last === null ? [] : await sourcesTried(last.runId);
  const outcomes = [...new Set(tried.map(({ outcome }) => outcome))];
  return {
    company,
    person: { country: country.value === null ? null : country },
    lastRun: last && { ...last, outcomes },
  };
}

/**
 * The person's run for the key, `request:<requestKey>`, and its status as it stands: the same key
 * answers the same run. enrichment_person_not_found, enrichment_input_invalid.
 */
export async function requestLeadRun(
  personId: string,
  requestKey: string,
): Promise<{ runId: string; status: LastRun["status"] }> {
  const { runId } = await requestEnrichment({ personId, requestKey });
  const run = await tenantClient.enrichmentRun.findFirst({
    where: { id: runId },
    select: { status: true },
  });
  return { runId, status: run?.status ?? "queued" };
}
