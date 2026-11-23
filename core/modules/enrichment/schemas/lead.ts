// The lead routes' path and answers (README "The lead page"), from which the api host builds the
// OpenAPI document and the web its client: a person's company facts and country, each with its
// source class and time, never a provider's name (RB-7.3.2), and the last run; a run on request,
// its id and status.
import { z } from "zod";
import { PANEL_FIELDS, RUN_STATUSES, RUN_TRIGGERS } from "../domain/lead/constants.ts";

const time = z.iso.datetime();

export const leadParams = z.strictObject({ personId: z.string().trim().min(1).max(64) });

/** A value with its source class (contacts' `contacts.provenance.source.*`) and when; null empty. */
const shown = <V extends z.ZodType>(value: V) =>
  z.strictObject({
    value: value.nullable(),
    sourceClass: z.string().nullable(),
    at: time.nullable(),
  });

export const leadEnrichmentResponse = z.strictObject({
  /** Null for a person with no company. */
  company: z
    .strictObject({
      name: z.string(),
      fields: z.array(
        shown(z.union([z.string(), z.number()])).extend({ field: z.enum(PANEL_FIELDS) }),
      ),
    })
    .nullable(),
  person: z.strictObject({ country: shown(z.string()).nullable() }),
  /** The person's latest run: the fields it filled by name and its outcomes, never a value or a source. */
  lastRun: z
    .strictObject({
      runId: z.string(),
      trigger: z.enum(RUN_TRIGGERS),
      status: z.enum(RUN_STATUSES),
      filled: z.array(z.string()),
      /** What its sources answered, each outcome once, in order: codes, never a source's name. */
      outcomes: z.array(z.string()),
      finishedAt: time.nullable(),
    })
    .nullable(),
});
export type LeadEnrichmentResponse = z.infer<typeof leadEnrichmentResponse>;

export const leadRunResponse = z.strictObject({
  runId: z.string(),
  status: z.enum(RUN_STATUSES),
});
export type LeadRunResponse = z.infer<typeof leadRunResponse>;
