// The request of contacts' export route (README.md "Routes"), from which the api builds its OpenAPI
// document; the answer is a CSV file, which the document does not describe.
import type { z } from "zod";
import { leadListQuery } from "./leads.ts";

/** The lead list's filters: a status, a tier, `unreviewed`; none is every lead. */
export const leadsCsvQuery = leadListQuery.pick({ status: true, tier: true, review: true });
export type LeadsCsvQuery = z.infer<typeof leadsCsvQuery>;
