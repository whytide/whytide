// The assessment's checks in code (docs/concepts.md "The assessment"; security §6). criteriaGate is
// the agent task's gate: it reads a valid output and returns issues, never throws and never changes
// it; the wrapper retries a failure once, then records ai_failed. groundVerdicts runs after the call:
// evidence quotes or paraphrases the person's data, or its criterion is unknown. Pure.
import type { GateResult } from "@whytide/ai";
import {
  type AssessFitInput,
  type AssessFitOutput,
  CRITERIA,
  type CriterionVerdict,
} from "../../schemas/assess-fit.ts";
import { PLACEHOLDERS } from "../anonymize/index.ts";

/** Words too common to ground a verdict. */
const STOP = new Set(
  "the and for with from that this are was has have not but its our their they you your into about over per via at in on of to an is as by or be no".split(
    " ",
  ),
);

/** Each of the six criteria exactly once; the issue names the criterion and the count, never a text. */
export function criteriaGate(output: AssessFitOutput): GateResult {
  const issues = CRITERIA.flatMap((criterion) => {
    const count = output.verdicts.filter((verdict) => verdict.criterion === criterion).length;
    const message = `${criterion}: ${count} verdicts, one expected`;
    return count === 1 ? [] : [{ path: "verdicts", message }];
  });
  return { gate: "criteria", issues };
}

/**
 * The verdicts as stored, in the criteria's order: one whose evidence is empty, or shares no word
 * with the person's data (the <profile>, <company> and <evidence> blocks, never the ICP's), is
 * `unknown`, since nothing in the input supports it; an `unknown` keeps no evidence.
 */
export function groundVerdicts(output: AssessFitOutput, input: AssessFitInput): CriterionVerdict[] {
  const { profile, company, evidence } = input;
  const data = [profile.headline, profile.title, profile.country, ...Object.values(company)];
  const known = words([...data, ...evidence].join(" "));
  return CRITERIA.map((criterion) => {
    const answer = output.verdicts.find((verdict) => verdict.criterion === criterion);
    const quote = answer?.evidence.trim() ?? "";
    const grounded = [...words(quote)].some((word) => known.has(word));
    if (answer && answer.verdict !== "unknown" && grounded) {
      return { criterion, verdict: answer.verdict, evidence: quote };
    }
    return { criterion, verdict: "unknown", evidence: "" };
  });
}

/** Letters and digits, lower case, accents gone; placeholders, stop words and single characters out. */
export function words(text: string): Set<string> {
  const plain = text.replace(PLACEHOLDERS, " ").normalize("NFKD").replace(/\p{M}/gu, "");
  const all = plain.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return new Set(all.filter((word) => word.length > 1 && !STOP.has(word)));
}
