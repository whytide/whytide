// The site reader's gates, in code (agents/read-company-site/README.md; security §6): each reads a
// valid output with the input the model read and returns issues, never throws and never changes the
// output; callAgent retries a failed gate once, the issues in <validation_error>, then answers
// ai_failed. An issue names a path and the rule broken, never a page's words. Pure: the task file
// imports it.
import type { GateResult } from "@whytide/ai";
import type {
  ReadCompanySiteInput,
  ReadCompanySiteOutput,
  SiteFact,
} from "../../../schemas/read-company-site.ts";
import { COUNTRY, FACT_LIMITS } from "./constants.ts";

type Cited = { readonly value: unknown; readonly url: string; readonly quote: string };

/** The facts given, each with its name. */
function given(output: ReadCompanySiteOutput): [SiteFact, Cited][] {
  return (Object.entries(output) as [SiteFact, Cited | null][]).filter(
    (entry): entry is [SiteFact, Cited] => entry[1] !== null,
  );
}

/** Lower case, each run of whitespace one space; `&lt;` read as `<`, since the blocks write `<` so. */
export function normalizeQuote(text: string): string {
  return text.replaceAll("&lt;", "<").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * grounded: every value names the `url` of a page of the input, and its quote, whitespace and case
 * aside, is words of that page's text; never empty.
 */
export function groundedGate(output: ReadCompanySiteOutput, input: ReadCompanySiteInput) {
  const texts = new Map(input.pages.map((page) => [page.url, normalizeQuote(page.text)]));
  const issues = given(output).flatMap(([fact, { url, quote }]) => {
    const text = texts.get(url);
    if (text === undefined) return [{ path: `${fact}.url`, message: "not the url of a page" }];
    const words = normalizeQuote(quote);
    if (words !== "" && text.includes(words)) return [];
    const message = words === "" ? "empty" : "not in the text of its page";
    return [{ path: `${fact}.quote`, message }];
  });
  return { gate: "grounded", issues } satisfies GateResult;
}

/** limits: each value within its bounds; a size's numbers whole and above zero, in order. */
export function limitsGate(output: ReadCompanySiteOutput) {
  const issues: { path: string; message: string }[] = [];
  const off = (fact: SiteFact, message: string) => issues.push({ path: `${fact}.value`, message });
  for (const fact of ["industry", "description"] as const) {
    const text = output[fact]?.value.trim();
    if (text === "") off(fact, "empty");
    if (text !== undefined && text.length > FACT_LIMITS[fact]) {
      off(fact, `longer than ${FACT_LIMITS[fact]} characters`);
    }
  }
  if (output.country !== null && !COUNTRY.test(output.country.value)) {
    off("country", "not an alpha-2 code");
  }
  if (output.employeeCount !== null && output.employeeCount.value < 1) {
    off("employeeCount", "below 1");
  }
  const range = output.employeeRange?.value;
  if (range !== undefined && (range.from < 1 || (range.to !== null && range.to < range.from))) {
    off("employeeRange", "not a range from 1");
  }
  return { gate: "limits", issues } satisfies GateResult;
}

export const READ_SITE_GATES = [groundedGate, limitsGate];
