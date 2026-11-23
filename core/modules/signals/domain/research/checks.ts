// The research plan's gates, in code (agents/research-plan/README.md "Gates"; gamma-wr-040): each reads
// the model's answer against what the run allows and refuses a part of it, never the whole: a source
// type off the list, a country outside the audience's, a language outside the source's (or, when it
// names none, off the kind's list), a query that is blank or longer than the port takes, a query the
// source asked within SIGNALS_RESEARCH_RECHECK_DAYS, and a query that repeats an earlier one of the
// same plan; and a role word (gamma-wr-090) that is too long or holds a contact. The rest of the plan is kept. The gates change nothing but what they refuse (words are
// trimmed and their blanks dropped) and count each refusal by gate name, never its text. The search's
// own gate (holdsContact, gamma-wr-041) refuses, just before a query is searched, one that holds an
// email address, a link or a phone number. Pure.
import type { GateResult } from "@whytide/ai";
import type { ResearchPickInput, ResearchPickOutput } from "../../schemas/research-pick-results.ts";
import type { ResearchPlanOutput } from "../../schemas/research-plan.ts";
import { scrub } from "../rate/scrub.ts";
import {
  type PlanGate,
  ROLE_WORD_MAX_CHARS,
  ROLE_WORDS_PER_LANGUAGE_MAX,
  WORD_MAX_CHARS,
  WORDS_PER_LANGUAGE_MAX,
} from "./constants.ts";

/** What the run allows. */
export type PlanBounds = {
  /** The ids of the source types on the list. */
  readonly places: ReadonlySet<string>;
  /** The audience's countries, upper case. */
  readonly countries: ReadonlySet<string>;
  /** The source's languages, lower case; empty when it names none. */
  readonly languages: ReadonlySet<string>;
  /** The kind's list of languages, which bounds a source that names none. */
  readonly kindLanguages: ReadonlySet<string>;
  /** The keys (queryKey) of the queries the source asked within the re-check days. */
  readonly asked: ReadonlySet<string>;
  /** Whether the search port takes this query text (its schema's own check). */
  readonly fits: (text: string) => boolean;
};

export type PlannedQuery = {
  readonly placeId: string;
  readonly country: string;
  readonly language: string;
  readonly text: string;
};
/** Words by language, as the plan keeps them. */
export type WordsByLanguage = readonly {
  readonly language: string;
  readonly words: readonly string[];
}[];
export type GatedPlan = {
  readonly words: WordsByLanguage;
  /** The words of the audience's roles by language (gamma-wr-090); none from a plan of an earlier version. */
  readonly roleWords: WordsByLanguage;
  /** The source types the plan uses: its own picks on the list, then those only a query names. */
  readonly placeIds: readonly string[];
  readonly queries: readonly PlannedQuery[];
  /** What each gate refused, by gate, only those that refused something. */
  readonly refused: Readonly<Partial<Record<PlanGate, number>>>;
};

/** A text with its whitespace squeezed to single spaces, compatibility forms folded, and trimmed. */
export const squeeze = (text: string): string =>
  text.normalize("NFKC").replace(/\s+/gu, " ").trim();

/** What makes two queries one: the text squeezed and lower-cased, with the country and the language. */
export const queryKey = (country: string, language: string, text: string): string =>
  `${country}\u0000${language}\u0000${squeeze(text).toLowerCase()}`;

/** The plan's answer gated against the bounds. */
export function gatePlan(output: ResearchPlanOutput, bounds: PlanBounds): GatedPlan {
  const refused: Partial<Record<PlanGate, number>> = {};
  const refuse = (gate: PlanGate) => {
    refused[gate] = (refused[gate] ?? 0) + 1;
  };
  const allowed = bounds.languages.size > 0 ? bounds.languages : bounds.kindLanguages;
  const languageOf = (code: string) => code.trim().toLowerCase();
  const languageOk = (code: string) => allowed.has(languageOf(code));

  /** The first gate that refuses the query, in the order of the module's README; null when none. */
  const refusedBy = (query: ResearchPlanOutput["queries"][number]): PlanGate | null => {
    if (!bounds.places.has(query.place)) return "place";
    const country = query.country.trim().toUpperCase();
    if (!bounds.countries.has(country)) return "country";
    if (!languageOk(query.language)) return "language";
    const text = squeeze(query.text);
    if (text === "" || !bounds.fits(text)) return "query";
    return bounds.asked.has(queryKey(country, languageOf(query.language), text)) ? "recheck" : null;
  };

  const words = new Map<string, string[]>();
  for (const entry of output.words) {
    if (!languageOk(entry.language)) {
      refuse("language");
      continue;
    }
    const kept = words.get(languageOf(entry.language)) ?? [];
    for (const word of entry.words.map(squeeze)) {
      const known = kept.some((other) => other.toLowerCase() === word.toLowerCase());
      if (word !== "" && [...word].length <= WORD_MAX_CHARS && !known) kept.push(word);
    }
    words.set(languageOf(entry.language), kept.slice(0, WORDS_PER_LANGUAGE_MAX));
  }

  // The role words: a language off the bounds is refused as the words' is; a word too long, or one that
  // holds an email address, a link or a phone number, is refused and counted; a blank or a repeat is left out.
  const roles = new Map<string, string[]>();
  for (const entry of output.roleWords ?? []) {
    if (!languageOk(entry.language)) {
      refuse("language");
      continue;
    }
    const kept = roles.get(languageOf(entry.language)) ?? [];
    for (const word of entry.words.map(squeeze)) {
      if (word === "") continue;
      if ([...word].length > ROLE_WORD_MAX_CHARS || holdsContact(word)) {
        refuse("role_word");
        continue;
      }
      if (!kept.some((other) => other.toLowerCase() === word.toLowerCase())) kept.push(word);
    }
    roles.set(languageOf(entry.language), kept.slice(0, ROLE_WORDS_PER_LANGUAGE_MAX));
  }

  const placeIds: string[] = [];
  const addPlace = (id: string) => {
    if (!placeIds.includes(id)) placeIds.push(id);
  };
  for (const id of new Set(output.places)) {
    if (bounds.places.has(id)) addPlace(id);
    else refuse("place");
  }

  const seen = new Set<string>();
  const queries: PlannedQuery[] = [];
  for (const query of output.queries) {
    const gate = refusedBy(query);
    if (gate !== null) {
      refuse(gate);
      continue;
    }
    const country = query.country.trim().toUpperCase();
    const language = languageOf(query.language);
    const text = squeeze(query.text);
    const key = queryKey(country, language, text);
    if (seen.has(key)) {
      refuse("duplicate");
      continue;
    }
    seen.add(key);
    queries.push({ placeId: query.place, country, language, text });
    addPlace(query.place);
  }
  return {
    words: [...words]
      .filter(([, list]) => list.length > 0)
      .map(([language, list]) => ({ language, words: list })),
    roleWords: [...roles]
      .filter(([, list]) => list.length > 0)
      .map(([language, list]) => ({ language, words: list })),
    placeIds,
    queries,
    refused,
  };
}

/** Groups of digits joined by single separators (space, dot, dash, parentheses), a leading + kept. */
const PHONE_RUN = /(?<![\p{L}\p{N}])\+?\(?\d+\)?(?:[\s.-]\(?\d+\)?)*(?![\p{L}\p{N}])/gu;
/** A phone number holds this many digits at least, a year's four (1900 to 2099) never counted. */
const PHONE_DIGITS_MIN = 7;
const YEAR = /^(?:19|20)\d{2}$/;

/** Whether the text holds a run of digits that looks like a phone number: years do not count toward it. */
export const holdsPhone = (text: string): boolean =>
  [...text.matchAll(PHONE_RUN)].some(([run]) => {
    const groups = run.match(/\d+/g) ?? [];
    const digits = groups.filter((group) => !YEAR.test(group)).join("").length;
    return digits >= PHONE_DIGITS_MIN;
  });

/**
 * Whether a query holds an email address, a link or a phone number. An email address or a link is what
 * the rating's scrub finds (digits masked first, so that a run of them is not its phone number); a
 * phone number is a run of 7 digits or more with single separators or a leading +, where a year (a
 * group of four digits from 1900 to 2099) never counts toward it: "2024 2025" and "tender 2025 lot
 * 123" pass, "+52 55 1234 5678", "(555) 123-4567" and "5551234567" do not. Such a query is never
 * searched: the model is told that no query names a person, and this is the gate in code behind it.
 */
export function holdsContact(text: string): boolean {
  return holdsEmailOrLink(text) || holdsPhone(text);
}

/**
 * Whether a text holds an email address or a link, the rating's scrub's: a postal address may hold a
 * postal code that looks like a phone number, which is no contact, so that this is its check (gamma-wr-050).
 */
export function holdsEmailOrLink(text: string): boolean {
  const masked = text.replace(/\d/gu, "x");
  return scrub(masked, "") !== masked;
}

/**
 * The result-picking agent's gate (agents/research-pick-results/README.md "Gate"): a valid answer read
 * against its input, issues returned, never a text and never a change. Each number picked is one of
 * the results the input holds, and none twice. callAgent asks again once with the failure, then the
 * call is `ai_failed`.
 */
export function picksGate(output: ResearchPickOutput, input: ResearchPickInput): GateResult {
  const known = new Set(input.results.map(({ index }) => index));
  const seen = new Set<number>();
  const issues = output.picks.flatMap(({ index }) => {
    const issue = (message: string) => [{ path: "picks", message }];
    if (!known.has(index)) return issue(`result ${index}: not one of the results`);
    if (seen.has(index)) return issue(`result ${index}: picked twice`);
    seen.add(index);
    return [];
  });
  return { gate: "picks", issues };
}
