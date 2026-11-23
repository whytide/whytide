// The country namer's data, version 1 (agents/name-country/README.md, gamma-en-075): the input, a
// lead's location text only, cleaned, at most LOCATION_MAX characters (RB-7.3.1); the output, a
// country's ISO 3166-1 alpha-2 code or null, and whether the model is sure. The code's form is the
// gate's (domain/name-country-gate.ts). A key the output schema does not declare is dropped.
import { z } from "zod";
import { LOCATION_MAX } from "../domain/constants.ts";

/** The task's name in the agent registry. */
export const NAME_COUNTRY = "enrichment.name-country";

export const nameCountryInput = z.object({ location: z.string().min(1).max(LOCATION_MAX) });
export type NameCountryInput = z.output<typeof nameCountryInput>;

export const nameCountryOutput = z.object({ country: z.string().nullable(), sure: z.boolean() });
export type NameCountryOutput = z.output<typeof nameCountryOutput>;
