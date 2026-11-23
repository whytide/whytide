// The people agents' gates, in code (agents/research-read-people/README.md "Gates",
// agents/research-pick-people/README.md; gamma-wr-060). The read's gates read the model's answer against
// the pages the company's people were read from and refuse a part of it, never the whole: a person whose
// page is not one of the pages, whose name or role is not on that page; a profile link that is not
// among that page's links or is no profile's address; an address that is not on that page or is not at
// the company's own domain (rule 29: a person's address only at the company's own domain); a place that
// is not on the page. The rest of the answer is kept. The gates change nothing but what they refuse,
// count each refusal by the gate's name, never its text, and merge a person named twice (by name) into
// one. The pick's gate refuses a number the input lacks or a number twice, so that the call is asked
// again once. Pure.
import type { GateResult } from "@whytide/ai";
import { countryOf, normalizeEmail, normalizeLinkedinUrl } from "@whytide/contacts";
import { cleanPhone, samePhone } from "@whytide/enrichment";
import type {
  ResearchPickPeopleInput,
  ResearchPickPeopleOutput,
} from "../../schemas/research-pick-people.ts";
import type { ResearchReadPeopleOutput } from "../../schemas/research-read-people.ts";
import { scrub } from "../rate/scrub.ts";
import { holdsPhone, squeeze } from "./checks.ts";
import { type PeopleGate, PICK_ROLE_CHARS } from "./constants.ts";
import { fit } from "./text.ts";

/** What the gates read of a page the people were read from. */
export type PeoplePageFacts = {
  readonly n: number;
  readonly address: string;
  readonly title: string;
  readonly text: string;
  readonly links: readonly string[];
  readonly mailto: readonly string[];
};

/** A person the pages name, kept: only what the gates found on the page. Held in memory, never stored as is. */
export type GatedPerson = {
  readonly name: string;
  readonly role: string;
  /** The profile as contacts keys it, `https://linkedin.com/in/<slug>`; null when the page prints none. */
  readonly profile: string | null;
  /** The address, lower case, at the company's own domain; null when the page prints none. */
  readonly email: string | null;
  /** The phone as enrichment keeps it (its form), printed on that page with this person only; null when the page prints none. */
  readonly phone: string | null;
  /** The country (a code) of the place the page gives for the person; null for none. */
  readonly country: string | null;
  /** The number of the page the person was found on. */
  readonly page: number;
};
export type GatedPeople = {
  readonly people: readonly GatedPerson[];
  /** What each gate refused, by gate, only those that refused something. */
  readonly refused: Readonly<Partial<Record<PeopleGate, number>>>;
};

/** A text folded for comparison: compatibility forms, case and whitespace. */
const fold = (text: string): string => squeeze(text).toLowerCase();
/**
 * Groups of digits joined by single separators (space, dot, dash, parentheses), a leading + kept; a
 * group may follow a closing parenthesis with no separator, `+49 (0)30 1234`.
 */
const PHONE_RUN = /(?<![\p{L}\p{N}])\+?\(?\d+\)?(?:(?:[\s.-]|(?<=\)))\(?\d+\)?)*(?![\p{L}\p{N}])/gu;
const digitsOf = (text: string): string => text.replace(/\D/gu, "");

/** A name as two spellings of one person are one: accents and punctuation folded away too. */
export const nameKeyOf = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Whether the address's domain is the company's domain or a subdomain of it. */
export function atDomain(address: string, domain: string): boolean {
  const host = address.slice(address.lastIndexOf("@") + 1);
  const own = domain.toLowerCase().replace(/^www\./u, "");
  return own !== "" && (host === own || host.endsWith(`.${own}`));
}

/**
 * The people the read answered, gated against the pages and the company's own domain. `companyPhones`
 * are the found company's own lines: a number that is one of them is the company's, not the person's.
 */
export function gatePeople(
  output: ResearchReadPeopleOutput,
  pages: readonly PeoplePageFacts[],
  domain: string,
  companyPhones: readonly string[] = [],
): GatedPeople {
  const refused: Partial<Record<PeopleGate, number>> = {};
  const refuse = (gate: PeopleGate) => {
    refused[gate] = (refused[gate] ?? 0) + 1;
  };
  const byNumber = new Map(pages.map((page) => [page.n, page]));
  const printed = new Map(
    pages.map(({ n, title, text }) => [n, fold(`${title}\n${text}`)] as const),
  );
  const kept = new Map<string, GatedPerson>();
  for (const answer of output.people) {
    const page = byNumber.get(answer.page);
    if (page === undefined) {
      refuse("page");
      continue;
    }
    const body = printed.get(page.n) ?? "";
    const name = squeeze(answer.name);
    if (name === "" || name.includes("@") || !body.includes(fold(name))) {
      refuse("name");
      continue;
    }
    const role = squeeze(answer.role);
    if (role === "" || !body.includes(fold(role))) {
      refuse("role");
      continue;
    }
    const person: GatedPerson = {
      ...{ name, role, page: page.n },
      profile: profileOn(answer.profile, page, refuse),
      email: emailOn(answer.email, page, body, domain, refuse),
      phone: phoneOn(answer.phone, `${page.title}\n${page.text}`, companyPhones, refuse),
      country: countryOn(answer.place, body, refuse),
    };
    const key = nameKeyOf(name);
    const earlier = kept.get(key);
    kept.set(key, earlier === undefined ? person : merged(earlier, person));
  }
  return { people: unshared([...kept.values()], refuse), refused };
}

/**
 * The number the page prints, its digits among a run of digits of its text, and not one of the found
 * company's lines. It is kept by its form (enrichment's cleanPhone), which drops what a number is not.
 */
function phoneOn(
  given: string | null,
  text: string,
  companyPhones: readonly string[],
  refuse: (gate: PeopleGate) => void,
): string | null {
  if (given === null || given.trim() === "") return null;
  // A date's or a year's groups are no number: `holdsPhone` counts none toward its seven digits.
  const phone = holdsPhone(given) ? cleanPhone(given) : null;
  const digits = phone === null ? "" : digitsOf(phone);
  const printed = [...text.matchAll(PHONE_RUN)].some(([run]) =>
    digitsOf(cleanPhone(run) ?? run).includes(digits),
  );
  if (phone === null || !printed) {
    refuse("phone");
    return null;
  }
  if (companyPhones.some((own) => samePhone(own, phone))) {
    refuse("phone_company");
    return null;
  }
  return phone;
}

/** A number given to more than one of the people is printed with more than one: kept for none of them. */
function unshared(
  people: readonly GatedPerson[],
  refuse: (gate: PeopleGate) => void,
): GatedPerson[] {
  return people.map((person) => {
    const { phone } = person;
    if (phone === null) return person;
    const shared = people.some(
      (other) => other !== person && other.phone !== null && samePhone(other.phone, phone),
    );
    if (!shared) return person;
    refuse("phone_shared");
    return { ...person, phone: null };
  });
}

/** The profile the page prints with the person: among the page's links and a profile's address. */
function profileOn(
  given: string | null,
  page: PeoplePageFacts,
  refuse: (gate: PeopleGate) => void,
): string | null {
  if (given === null || given.trim() === "") return null;
  const profile = normalizeLinkedinUrl(given);
  if (profile !== null && page.links.some((link) => normalizeLinkedinUrl(link) === profile)) {
    return profile;
  }
  refuse("profile");
  return null;
}

/** The address the page prints, at the company's own domain: any other is dropped. */
function emailOn(
  given: string | null,
  page: PeoplePageFacts,
  body: string,
  domain: string,
  refuse: (gate: PeopleGate) => void,
): string | null {
  if (given === null || given.trim() === "") return null;
  const address = normalizeEmail(given);
  const onPage =
    address !== null &&
    (body.includes(address) || page.mailto.some((mailto) => normalizeEmail(mailto) === address));
  if (address !== null && onPage && atDomain(address, domain)) return address;
  refuse("email");
  return null;
}

/** The country of the place the page gives for the person; a place that is not on the page is dropped. */
function countryOn(
  given: string | null,
  body: string,
  refuse: (gate: PeopleGate) => void,
): string | null {
  if (given === null || given.trim() === "") return null;
  if (!body.includes(fold(given))) {
    refuse("place");
    return null;
  }
  return countryOf(given);
}

/** A person named twice is one: the first's values, a missing key or country filled from the second. */
function merged(first: GatedPerson, second: GatedPerson): GatedPerson {
  return {
    ...first,
    profile: first.profile ?? second.profile,
    email: first.email ?? second.email,
    phone: first.phone ?? second.phone,
    country: first.country ?? second.country,
  };
}

/**
 * The pick's input (rule 35): a number and the role's text for each person, the role scrubbed of links,
 * email addresses, phone numbers and the name of every person read, so that no name, link or address
 * reaches the model, and cut. The audience's titles and seniorities come with `limit`.
 */
export function pickInputOf(
  people: readonly Pick<GatedPerson, "name" | "role">[],
  audience: ResearchPickPeopleInput["audience"],
  limit: number,
): ResearchPickPeopleInput {
  const names = people.map(({ name }) => name).join(" ");
  return {
    audience,
    limit,
    people: people.map(({ role }, n) => ({
      index: n + 1,
      role: fit(scrub(role, names) ?? "", PICK_ROLE_CHARS),
    })),
  };
}

/**
 * The pick's gate: each number is one of the input's people, and none twice. callAgent asks again once
 * with the failure, then the call is `ai_failed`.
 */
export function peoplePicksGate(
  output: ResearchPickPeopleOutput,
  input: ResearchPickPeopleInput,
): GateResult {
  const known = new Set(input.people.map(({ index }) => index));
  const seen = new Set<number>();
  const issues = output.picks.flatMap(({ index }) => {
    const issue = (message: string) => [{ path: "picks", message }];
    if (!known.has(index)) return issue(`person ${index}: not one of the people`);
    if (seen.has(index)) return issue(`person ${index}: picked twice`);
    seen.add(index);
    return [];
  });
  return { gate: "people_picks", issues };
}

/** The people the picks name, in the picks' order, the first `cap` of them. */
export function chosenOf<T>(
  people: readonly T[],
  output: ResearchPickPeopleOutput,
  cap: number,
): T[] {
  return output.picks.slice(0, cap).flatMap(({ index }) => people[index - 1] ?? []);
}
