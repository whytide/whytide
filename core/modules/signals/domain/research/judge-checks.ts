// The company judge's gates, in code (agents/research-judge-company/README.md "Gates"; gamma-wr-050): each
// reads the model's answer against the pages of the company's site that were read and refuses a part of
// it, never the whole. An answer of `shown` or `contradicted` stands only with a line and a quote that
// is on its page (at least eight characters, holding no email address, link or phone number); else it
// counts as `not_stated`. A country, a town and a state must be on their page, an email address on its
// page and not a person's, a phone number's digits on its page, a postal address on its page; else the
// value is dropped. Each refusal is counted by the gate's name, never its text. The verdict is not
// here (verdict.ts). Pure.
import { countryCode } from "@whytide/contacts";
import type { ResearchJudgeOutput } from "../../schemas/research-judge-company.ts";
import { holdsContact, holdsEmailOrLink, squeeze } from "./checks.ts";
import {
  type Answer,
  CRITERIA_MAX,
  type JudgeGate,
  PLACE_QUOTE_MIN_CHARS,
  QUOTE_MIN_CHARS,
  SITE_PHONE_DIGITS_MAX,
  SITE_PHONE_DIGITS_MIN,
} from "./constants.ts";

/** A page of the site as the model read it, and the `mailto:` addresses its links hold. */
export type SitePageFacts = {
  readonly address: string;
  readonly title: string;
  readonly text: string;
  readonly mailto: readonly string[];
};

/** An answer after the gates: `not_stated` carries nothing; the page is the index in the pages, from 0. */
export type GatedAnswer =
  | { readonly answer: "not_stated" }
  | {
      readonly answer: "shown" | "contradicted";
      readonly line: string;
      readonly quote: string;
      readonly page: number;
    };

export type GatedJudgment = {
  readonly focus: GatedAnswer;
  /** One for each must-have and each disqualifier the audience holds, in order, `not_stated` for one left out. */
  readonly mustHaves: readonly GatedAnswer[];
  readonly disqualifiers: readonly GatedAnswer[];
  readonly industry: GatedAnswer;
  readonly size: GatedAnswer;
  readonly onePerson: boolean;
  readonly country: { readonly code: string; readonly quote: string; readonly page: number } | null;
  readonly town: string | null;
  readonly state: string | null;
  readonly email: { readonly address: string; readonly page: number } | null;
  readonly phones: readonly { readonly number: string; readonly page: number }[];
  readonly postal: { readonly address: string; readonly page: number } | null;
  /** What each gate refused, by gate, only those that refused something. */
  readonly refused: Readonly<Partial<Record<JudgeGate, number>>>;
};

/** A text folded for comparison: compatibility forms, case and whitespace. */
const fold = (text: string): string => squeeze(text).toLowerCase();
const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/u;
const PHONE_CHARS = /^[+\d\s().-]+$/u;
const digitsOf = (text: string): string => text.replace(/\D/gu, "");

/**
 * The model's answer gated against the pages (the order the model read them, its numbers from 1),
 * with the number of must-haves and disqualifiers the audience holds. A number the model answers
 * that is none of the audience's, or twice, is left out.
 */
export function gateJudgment(
  output: ResearchJudgeOutput,
  pages: readonly SitePageFacts[],
  criteria: { readonly mustHaves: number; readonly disqualifiers: number },
): GatedJudgment {
  const refused: Partial<Record<JudgeGate, number>> = {};
  const refuse = (gate: JudgeGate) => {
    refused[gate] = (refused[gate] ?? 0) + 1;
  };
  const folded = pages.map(({ title, text }) => fold(`${title}\n${text}`));
  const pageAt = (number: number): number | null =>
    number >= 1 && number <= pages.length ? number - 1 : null;

  const answerOf = (given: {
    answer: Answer;
    line: string | null;
    quote: string | null;
    page: number | null;
  }): GatedAnswer => {
    if (given.answer === "not_stated") return { answer: "not_stated" };
    const line = given.line === null ? "" : squeeze(given.line);
    const quote = given.quote === null ? "" : squeeze(given.quote);
    const page = given.page === null ? null : pageAt(given.page);
    if (holdsContact(line) || holdsContact(quote)) {
      refuse("contact");
      return { answer: "not_stated" };
    }
    const body = page === null ? undefined : folded[page];
    if (
      page === null ||
      body === undefined ||
      line === "" ||
      [...quote].length < QUOTE_MIN_CHARS ||
      !body.includes(fold(quote))
    ) {
      refuse("quote");
      return { answer: "not_stated" };
    }
    return { answer: given.answer, line, quote, page };
  };
  const listOf = (items: ResearchJudgeOutput["mustHaves"], held: number): GatedAnswer[] => {
    const byNumber = new Map<number, GatedAnswer>();
    for (const item of items) {
      if (item.n > held || item.n > CRITERIA_MAX || byNumber.has(item.n)) continue;
      byNumber.set(item.n, answerOf(item));
    }
    return Array.from(
      { length: held },
      (_, at) => byNumber.get(at + 1) ?? { answer: "not_stated" },
    );
  };

  const onPage = (value: string, page: number): boolean => {
    const at = pageAt(page);
    return at !== null && (folded[at] ?? "").includes(fold(value));
  };
  const placeWord = (given: { value: string; page: number } | null): string | null => {
    if (given === null) return null;
    const value = squeeze(given.value);
    if (value === "") return null;
    if (holdsContact(value) || !onPage(value, given.page)) {
      refuse("place");
      return null;
    }
    return value;
  };
  let country: GatedJudgment["country"] = null;
  if (output.country !== null) {
    const { code, quote, page } = output.country;
    const known = countryCode(code.trim());
    const words = squeeze(quote);
    const at = pageAt(page);
    if (
      known === null ||
      at === null ||
      [...words].length < PLACE_QUOTE_MIN_CHARS ||
      holdsContact(words) ||
      !onPage(words, page)
    )
      refuse("place");
    else country = { code: known, quote: words, page: at };
  }

  let email: GatedJudgment["email"] = null;
  if (output.email !== null) {
    const address = output.email.address.trim().toLowerCase();
    const at = pageAt(output.email.page);
    const page = at === null ? undefined : pages[at];
    const printed =
      page !== undefined &&
      (fold(page.text).includes(address) ||
        page.mailto.some((one) => one.toLowerCase() === address));
    if (output.email.kind !== "general" || !EMAIL.test(address) || !printed || at === null)
      refuse("email");
    else email = { address, page: at };
  }

  const phones: { number: string; page: number }[] = [];
  const seenDigits = new Set<string>();
  for (const { number, page } of output.phones) {
    const shown = squeeze(number);
    const digits = digitsOf(shown);
    const at = pageAt(page);
    const body = at === null ? undefined : pages[at];
    if (
      body === undefined ||
      at === null ||
      !PHONE_CHARS.test(shown) ||
      digits.length < SITE_PHONE_DIGITS_MIN ||
      digits.length > SITE_PHONE_DIGITS_MAX ||
      !digitsOf(body.text).includes(digits)
    ) {
      refuse("phone");
      continue;
    }
    if (seenDigits.has(digits)) continue;
    seenDigits.add(digits);
    phones.push({ number: shown, page: at });
  }

  let postal: GatedJudgment["postal"] = null;
  if (output.postal !== null) {
    const address = squeeze(output.postal.address);
    const at = pageAt(output.postal.page);
    if (
      at === null ||
      address === "" ||
      holdsEmailOrLink(address) ||
      !onPage(address, output.postal.page)
    )
      refuse("postal");
    else postal = { address, page: at };
  }

  const onePerson = answerOf(output.onePerson).answer === "shown";
  return {
    focus: answerOf(output.focus),
    mustHaves: listOf(output.mustHaves, criteria.mustHaves),
    disqualifiers: listOf(output.disqualifiers, criteria.disqualifiers),
    industry: answerOf(output.industry),
    size: answerOf(output.size),
    onePerson,
    country,
    town: placeWord(output.town),
    state: placeWord(output.state),
    email,
    phones,
    postal,
    refused,
  };
}
