// The triage agent's input and output (agents/triage-engagers/README.md; signals-triage-ai). The
// input, a field per data block: the ICP's targeting the triage reads, its titles, seniorities,
// industries and must-haves, and up to TRIAGE_BATCH_SIZE staged candidates, each its role and its
// headline, scrubbed; never a name, a profile URL, a company or a member reference. The output: one
// decision per candidate, by its index, and a skip's code.
import { z } from "zod";
import { TRIAGE_BATCH_SIZE } from "../domain/constants.ts";
import { RATE_ROLES } from "./rate-engagement.ts";

export const TRIAGE_ENGAGERS = "signals.triage-engagers";
/** What the triage decides of a candidate: skipped, read before the rest, or read. */
export const TRIAGE_DECISIONS = ["skip", "read_first", "read"] as const;
/** The kinds of person a skip names: two of qualification's people-type disqualifiers. */
export const TRIAGE_CODES = ["recruiter", "job_seeker"] as const;

/** icp's bounds: a title or an industry of 100 characters, a text of 1,000. */
const item = z.string().max(100);
/** A staged headline is 300 characters; its placeholders may lengthen it. */
const headline = z.string().max(600);
const index = z.number().int().min(1).max(TRIAGE_BATCH_SIZE);

export const triageEngagersInput = z.strictObject({
  icp: z.strictObject({
    titles: z.array(item).max(50),
    seniorities: z.array(z.string().max(32)).max(8),
    industries: z.array(item).max(30),
    mustHaves: z.string().max(1_000),
  }),
  candidates: z
    .array(z.strictObject({ index, role: z.enum(RATE_ROLES), headline }))
    .min(1)
    .max(TRIAGE_BATCH_SIZE),
});
export type TriageEngagersInput = z.output<typeof triageEngagersInput>;

export const triageEngagersOutput = z.strictObject({
  decisions: z
    .array(
      z.strictObject({
        index,
        decision: z.enum(TRIAGE_DECISIONS),
        code: z.enum(TRIAGE_CODES).nullable(),
      }),
    )
    .min(1)
    .max(TRIAGE_BATCH_SIZE),
});
export type TriageEngagersOutput = z.output<typeof triageEngagersOutput>;
