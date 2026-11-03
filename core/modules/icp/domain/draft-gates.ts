// The drafter's gate, in code (agents/draft-profile/README.md; security §6): what the output schema
// cannot say, the lengths and counts icpBody checks (schemas/icp.ts), and no value twice in a list.
// It reads a valid output and returns issues, never throws and never changes the output; callAgent
// retries a failed gate once, the issues in <validation_error>, then answers ai_failed. An issue
// names a path and the rule broken, never a value. Pure; it imports none of the module's registries,
// since the task file loads it from the sources.
import type { AgentIssue, GateResult } from "@whytide/ai";
import type { DraftProfileOutput } from "../schemas/draft-profile.ts";
import { LIMITS } from "./lists.ts";

/** The texts with their lengths, the free-text lists with their counts, and every list. */
const TEXTS = { name: LIMITS.name, mustHaves: LIMITS.text, disqualifiers: LIMITS.text } as const;
const COUNTS = { titles: LIMITS.titles, industries: LIMITS.industries } as const;
const LISTS = ["titles", "seniorities", "industries", "sizeRanges", "countries"] as const;

/** Each text and list within its limit, each title and industry 1 to 100 characters, none twice. */
export function limitsGate(output: DraftProfileOutput): GateResult {
  const issues: AgentIssue[] = [];
  for (const [field, max] of Object.entries(TEXTS)) {
    const text = output[field as keyof typeof TEXTS];
    if (text.trim().length > max) issues.push({ path: field, message: `over ${max} characters` });
  }
  for (const [field, max] of Object.entries(COUNTS)) {
    const items = output[field as keyof typeof COUNTS];
    if (items.length > max) issues.push({ path: field, message: `more than ${max} items` });
    for (const [at, item] of items.entries()) {
      const length = item.trim().length;
      const message = `not 1 to ${LIMITS.item} characters`;
      if (length === 0 || length > LIMITS.item) issues.push({ path: `${field}.${at}`, message });
    }
  }
  for (const field of LISTS) {
    const seen = new Set<string>();
    for (const [at, item] of output[field].entries()) {
      const key = item.trim().toLowerCase();
      if (seen.has(key)) issues.push({ path: `${field}.${at}`, message: "given twice" });
      seen.add(key);
    }
  }
  return { gate: "limits", issues };
}

export const DRAFT_PROFILE_GATES = [limitsGate];
