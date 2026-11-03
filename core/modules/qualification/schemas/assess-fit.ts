// The assessment agent's data, version 1 (agents/assess-fit/README.md): the input, one field per data
// block of the prompt, from domain/anonymize/ and the ICP; and the output, whose criteria, verdicts
// and disqualifiers are closed lists, so the model can answer nothing else (security §6). The input's
// objects are an allow-list too: callAgent parses the input with this schema and drops any key it
// does not declare before a block is written.
import type { CriterionKey } from "@whytide/icp";
import { z } from "zod";

/** The task's name in the agent registry. */
export const ASSESS_FIT = "qualification.assess-fit";

/** icp's six criteria (its CRITERION_KEYS), in its order; tests/anonymize.test.ts checks the type. */
export const CRITERIA = [
  "title_function",
  "seniority",
  "company_size",
  "industry",
  "location",
  "must_haves",
] as const satisfies readonly CriterionKey[];
export const VERDICTS = ["met", "partially_met", "not_met", "unknown"] as const;
/** F04 §4.2's closed list: any one of them means not qualified, whatever the fit (alpha-p6-030). */
export const DISQUALIFIERS = [
  "competitor",
  "agency_or_consultant",
  "freelancer",
  "student_or_intern",
  "job_seeker",
  "recruiter",
  "wrong_business_model",
  "own_company",
  "existing_customer",
  "left_company",
  "fake_or_inactive_profile",
] as const;
export type Criterion = (typeof CRITERIA)[number];
export type Verdict = (typeof VERDICTS)[number];
export type Disqualifier = (typeof DISQUALIFIERS)[number];

const text = z.string().nullable();
const list = z.array(z.string());

/** The blocks, in the prompt header's order. */
export const assessFitInput = z.object({
  profile: z.object({ headline: text, title: text, country: text }),
  company: z.object({ name: text, industry: text, size: text }),
  evidence: list,
  icp: z.object({
    titles: list,
    seniorities: list,
    industries: list,
    company_sizes: list,
    countries: list,
  }),
  must_haves: z.string(),
  disqualifiers: z.string(),
});
export type AssessFitInput = z.output<typeof assessFitInput>;

const verdict = z.object({
  criterion: z.enum(CRITERIA),
  verdict: z.enum(VERDICTS),
  evidence: z.string(),
});
/** Each criterion once is the task's gate (domain/assess/checks.ts), not a length here. */
export const assessFitOutput = z.object({
  verdicts: z.array(verdict),
  disqualifiers: z.array(z.enum(DISQUALIFIERS)),
  summary: z.string(),
});
export type AssessFitOutput = z.output<typeof assessFitOutput>;
export type CriterionVerdict = z.output<typeof verdict>;
