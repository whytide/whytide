// A company's managers by search, in code (README.md "Web research"; gamma-wr-090): the query, which
// results are taken, the read's gates and the people the pages gave already. Pure. The query holds the
// company's name and the role words of the search's language and never a person's name: the plan's role
// words hold none (checks.ts), and the search gate (holdsContact) still refuses a query that holds an
// email address, a link or a phone number. A result is taken only when its address is a profile's
// (`normalizeLinkedinUrl`, compared and never fetched: no request goes to linkedin.com) and its title and
// snippet name the company, names cleaned as enrichment cleans them (`normalName`), as
// people-profile.ts takes the result of a person's own search. The AI reads the name and the role; its
// answer is gated here: the result is one of those given, the name and the role are in that result's
// own text, and a result that gives no role is not taken. The gates refuse a part of the answer, never
// the whole, and are counted by their name, never their text.
import { normalizeLinkedinUrl } from "@whytide/contacts";
import { normalName } from "@whytide/enrichment";
import type { WebResult } from "@whytide/providers";
import { z } from "zod";
import type { ResearchReadResultOutput } from "../../schemas/research-read-result.ts";
import { squeeze } from "./checks.ts";
import {
  MANAGERS_NAME_CHARS,
  MANAGERS_PAGE,
  MANAGERS_QUERY_CHARS,
  MANAGERS_ROLE_WORDS_IN_QUERY,
  MANAGERS_SNIPPET_CHARS,
  MANAGERS_TITLE_CHARS,
  type ManagersGate,
} from "./constants.ts";
import { type GatedPerson, nameKeyOf } from "./people-checks.ts";
import { holds } from "./people-profile.ts";
import { clean, fit } from "./text.ts";

/** A plan's role words by language, as `signal_research_plans.role_words` keeps them. */
const roleWordsSchema = z.array(z.object({ language: z.string(), words: z.array(z.string()) }));
export type RoleWords = z.output<typeof roleWordsSchema>;

/** The plan's role words as stored; none for a plan of an earlier version or a value off the form. */
export function roleWordsOf(stored: unknown): RoleWords {
  const parsed = roleWordsSchema.safeParse(stored);
  return parsed.success ? parsed.data.filter(({ words }) => words.length > 0) : [];
}

/**
 * The role words of the search's language: those of `preferred` (the language of the query that led to
 * the company) when the plan has some, else the first language the plan wrote; null for none.
 */
export function wordsForSearch(roleWords: RoleWords, preferred: string | null): string[] | null {
  const entry = roleWords.find(({ language }) => language === preferred) ?? roleWords[0];
  if (entry === undefined) return null;
  const words = entry.words
    .map((word) => squeeze(word.replaceAll('"', "")))
    .filter((w) => w !== "");
  return words.length === 0 ? null : words.slice(0, MANAGERS_ROLE_WORDS_IN_QUERY);
}

/**
 * The query: the company's name quoted, then the role words, each quoted, as one group of alternatives.
 * Words that would take it past the port's bound are left out.
 */
export function managersQuery(companyName: string, words: readonly string[]): string {
  const name = `"${fit(companyName.replaceAll('"', ""), MANAGERS_NAME_CHARS)}"`;
  const kept: string[] = [];
  for (const word of words) {
    const next = [...kept, `"${word}"`];
    if (`${name} (${next.join(" OR ")})`.length > MANAGERS_QUERY_CHARS) break;
    kept.push(`"${word}"`);
  }
  return kept.length === 0 ? name : `${name} (${kept.join(" OR ")})`;
}

/** A result code took: its number from 1 (the read's), its profile as contacts keys it, its cut texts. */
export type ManagerResult = {
  readonly n: number;
  readonly profile: string;
  readonly title: string;
  readonly snippet: string;
};

/**
 * The results taken: an address that is a profile's, whose title and snippet name the company; one
 * profile once, in the results' order, numbered from 1.
 */
export function managerResultsOf(
  results: readonly Pick<WebResult, "url" | "title" | "snippet">[],
  companyName: string,
): ManagerResult[] {
  const company = normalName(companyName);
  const seen = new Set<string>();
  const taken: ManagerResult[] = [];
  for (const { url, title, snippet } of results) {
    const profile = normalizeLinkedinUrl(url);
    if (profile === null || seen.has(profile)) continue;
    if (!holds(normalName(`${title} ${snippet}`), company)) continue;
    seen.add(profile);
    taken.push({
      ...{ n: taken.length + 1, profile },
      title: clean(title, MANAGERS_TITLE_CHARS),
      snippet: clean(snippet, MANAGERS_SNIPPET_CHARS),
    });
  }
  return taken;
}

/** A person a result gives: what the gates found in its title and snippet. Held in memory, never stored as is. */
export type ManagerPerson = GatedPerson & {
  /** The result's title, kept as the evidence shows it. */
  readonly title: string;
};
export type GatedManagers = {
  readonly people: readonly ManagerPerson[];
  /** What each gate refused, by gate, only those that refused something. */
  readonly refused: Readonly<Partial<Record<ManagersGate, number>>>;
};

/** The people the read answered, gated against the results given to it. */
export function gateManagers(
  output: ResearchReadResultOutput,
  results: readonly ManagerResult[],
): GatedManagers {
  const refused: Partial<Record<ManagersGate, number>> = {};
  const refuse = (gate: ManagersGate) => {
    refused[gate] = (refused[gate] ?? 0) + 1;
  };
  const byNumber = new Map(results.map((result) => [result.n, result]));
  const done = new Set<number>();
  const people: ManagerPerson[] = [];
  for (const answer of output.people) {
    const result = byNumber.get(answer.result);
    if (result === undefined || done.has(result.n)) {
      refuse("result");
      continue;
    }
    const text = normalName(`${result.title} ${result.snippet}`);
    const name = squeeze(answer.name);
    if (name === "" || name.includes("@") || !holds(text, normalName(name))) {
      refuse("name");
      continue;
    }
    const role = squeeze(answer.role);
    if (role === "" || !holds(text, normalName(role))) {
      refuse("role");
      continue;
    }
    done.add(result.n);
    people.push({
      ...{ name, role, profile: result.profile, email: null, country: null, phone: null },
      ...{ page: MANAGERS_PAGE, title: result.title },
    });
  }
  return { people, refused };
}

/**
 * The people of the results that no page named already: one lead for a person on a page and among the
 * results. A person is the same by their profile, or by their name (accents, case and punctuation
 * aside); a name twice among the results is the first's.
 */
export function withoutPagePeople(
  found: readonly ManagerPerson[],
  pagePeople: readonly Pick<GatedPerson, "name" | "profile">[],
): ManagerPerson[] {
  const names = new Set(pagePeople.map(({ name }) => nameKeyOf(name)));
  const profiles = new Set(pagePeople.flatMap(({ profile }) => profile ?? []));
  const kept: ManagerPerson[] = [];
  for (const person of found) {
    const key = nameKeyOf(person.name);
    if (names.has(key) || (person.profile !== null && profiles.has(person.profile))) continue;
    names.add(key);
    kept.push(person);
  }
  return kept;
}
