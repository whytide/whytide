// The verdict on a company, decided by code from the judge's gated answers (README.md "Web research";
// agents/research-judge-company/README.md; gamma-wr-050): the model answers closed questions, this
// rule decides, so that a page cannot talk the run into a verdict. `not_fit`: the focus or a must-have
// is contradicted, a disqualifier is shown, or the company's country is outside the audience's;
// `fit`: otherwise, when the focus and every must-have are shown; `unsure`: the rest. Industry and size
// add reasons and decide nothing: qualification judges them for each lead. A disqualifier the site
// does not state is no reason against the company. Pure.

import type { ReasonKind, Verdict } from "./constants.ts";
import type { GatedAnswer, GatedJudgment, SitePageFacts } from "./judge-checks.ts";

/** What the rule reads: the gated answers' answers, the company's country and the audience's. */
export type VerdictFacts = {
  readonly focus: GatedAnswer["answer"];
  readonly mustHaves: readonly GatedAnswer["answer"][];
  readonly disqualifiers: readonly GatedAnswer["answer"][];
  /** The company's country code when the site gave one the gates kept. */
  readonly country: string | null;
  /** The audience's countries, upper case; empty when the audience names none. */
  readonly audienceCountries: readonly string[];
};

/** Whether the company's country is known and outside the audience's. */
export function outsideCountries(
  country: string | null,
  audienceCountries: readonly string[],
): boolean {
  return (
    country !== null &&
    audienceCountries.length > 0 &&
    !audienceCountries.some((code) => code.toUpperCase() === country.toUpperCase())
  );
}

export function verdictOf(facts: VerdictFacts): Verdict {
  const { focus, mustHaves, disqualifiers, country, audienceCountries } = facts;
  if (
    focus === "contradicted" ||
    mustHaves.includes("contradicted") ||
    disqualifiers.includes("shown") ||
    outsideCountries(country, audienceCountries)
  )
    return "not_fit";
  if (focus === "shown" && mustHaves.every((answer) => answer === "shown")) return "fit";
  return "unsure";
}

/** A reason as the found company keeps it: a line about the company, its quote, the page and the date read. */
export type Reason = {
  readonly kind: ReasonKind;
  /** The must-have's or disqualifier's text, for those two kinds. */
  readonly criterion?: string;
  readonly answer: "shown" | "contradicted";
  readonly line: string;
  readonly quote: string;
  readonly url: string;
  readonly readAt: string;
};

/**
 * The reasons of a judgment, in the order the questions were asked: each answer of `shown` or
 * `contradicted` of the focus, the must-haves, the disqualifiers, the industry and the size, then the
 * country when the audience names some (`shown` inside them, `contradicted` outside). A page's address is
 * the one the step kept, without its query.
 */
export function reasonsOf(
  gated: GatedJudgment,
  input: {
    readonly mustHaves: readonly string[];
    readonly disqualifiers: readonly string[];
    readonly pages: readonly SitePageFacts[];
    readonly audienceCountries: readonly string[];
    readonly readAt: Date;
  },
): Reason[] {
  const { pages, readAt } = input;
  const at = readAt.toISOString();
  const reasons: Reason[] = [];
  const add = (kind: ReasonKind, answer: GatedAnswer, criterion?: string) => {
    if (answer.answer === "not_stated") return;
    const page = pages[answer.page];
    if (page === undefined) return;
    const { line, quote } = answer;
    reasons.push({
      ...{ kind, ...(criterion === undefined ? {} : { criterion }) },
      ...{ answer: answer.answer, line, quote, url: page.address, readAt: at },
    });
  };
  add("focus", gated.focus);
  gated.mustHaves.forEach((answer, at) => add("must_have", answer, input.mustHaves[at]));
  gated.disqualifiers.forEach((answer, at) => add("disqualifier", answer, input.disqualifiers[at]));
  add("industry", gated.industry);
  add("size", gated.size);
  const { country } = gated;
  const page = country === null ? undefined : pages[country.page];
  if (country !== null && page !== undefined && input.audienceCountries.length > 0) {
    const outside = outsideCountries(country.code, input.audienceCountries);
    reasons.push({
      ...{ kind: "country", answer: outside ? "contradicted" : "shown" },
      ...{ line: country.code, quote: country.quote, url: page.address, readAt: at },
    });
  }
  return reasons;
}
