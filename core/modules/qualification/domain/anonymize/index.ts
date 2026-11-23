// The anonymizer (docs/security.md "Anonymization"; security §6, RB-5.1.2): what the assessment agent
// sees of a person is an allow-list, the headline, the title and the country, the company's name,
// industry and size, and the evidence excerpts. Nothing else of the records is read, whatever they
// carry, so a field added to contacts later never reaches the model by itself. Every text kept loses
// the person's names, links and email addresses; the person's own texts also lose pronouns, gendered
// words and ages; the company's texts keep theirs, which describe its market, not the person. No
// field of a special category is read; a free text may still mention one, and the prompt forbids its
// use. Pure: it imports nothing.

/** What it reads of a person; contacts' Person satisfies it. The names are read to be removed. */
export type AnonymizerPerson = {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly headline?: string | null;
  readonly title?: string | null;
  /** ISO 3166-1 alpha-2. */
  readonly locationCountry?: string | null;
};
/** What it reads of the person's company; contacts' WorkspaceCompany satisfies it. */
export type AnonymizerCompany = {
  readonly name?: string | null;
  readonly industry?: string | null;
  readonly sizeRange?: string | null;
};
/** The agent's <profile>, <company> and <evidence> blocks. */
export type Anonymized = {
  readonly profile: { headline: string | null; title: string | null; country: string | null };
  readonly company: { name: string | null; industry: string | null; size: string | null };
  readonly evidence: string[];
};

/** What stands where a name, a link or an address was; the evidence check ignores them. */
export const PLACEHOLDERS = /\[(?:name|link|email)\]/g;
/** Characters read of any text, which bounds the expressions' work; an excerpt keeps fewer. */
const READ = 1000;
/** The excerpts of the person's own words the model reads at most (the batch asks for as many). */
export const EXCERPTS = 5;
const EXCERPT = 500;
const EDGE = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** A declaration of pronouns: `she/her`, `(he/him/his)`, `pronouns: they/them`. */
const PRONOUNS =
  /\(?\s*(?:pronouns?\s*:?\s*)?\b(?:she|he|they|ze|xe)\s*\/\s*(?:her|hers|him|his|them|theirs|they|she|he|zir|xem)(?:\s*\/\s*(?:hers|his|theirs|zir|xem))?\b\s*\)?/gi;
const HONORIFIC = new RegExp(`${EDGE}(?:mr|mrs|ms|mx|sir|madam|dame)\\.?${END}`, "giu");
const AGE =
  /\b(?:\d{1,3}\s*-?\s*(?:years?|yrs?)\s*-?\s*old|\d{1,3}\s*(?:y\/o|yo)|aged?\s*:?\s*\d{1,3}|born\s+(?:in\s+)?\d{4}|class\s+of\s+\d{4}|in\s+(?:my|their|his|her)\s+(?:\d0'?s|twenties|thirties|forties|fifties|sixties|seventies)|gen\s*z|millennials?|boomers?)\b/gi;
/** A word that tells gender, and the neutral one put in its place. */
const NEUTRAL: Readonly<Record<string, string>> = {
  he: "they",
  she: "they",
  him: "them",
  her: "their",
  his: "their",
  hers: "theirs",
  himself: "themselves",
  herself: "themselves",
  chairman: "chair",
  chairwoman: "chair",
  businessman: "businessperson",
  businesswoman: "businessperson",
  salesman: "salesperson",
  saleswoman: "salesperson",
  spokesman: "spokesperson",
  spokeswoman: "spokesperson",
  man: "person",
  woman: "person",
  men: "people",
  women: "people",
  male: "",
  female: "",
  mother: "parent",
  father: "parent",
  mom: "parent",
  mum: "parent",
  dad: "parent",
  mothers: "parents",
  fathers: "parents",
  moms: "parents",
  mums: "parents",
  dads: "parents",
  grandmother: "grandparent",
  grandfather: "grandparent",
  son: "child",
  daughter: "child",
  sons: "children",
  daughters: "children",
  brother: "sibling",
  sister: "sibling",
  wife: "spouse",
  husband: "spouse",
  girl: "person",
  boy: "person",
  girls: "people",
  boys: "people",
  lady: "person",
  ladies: "people",
  gentleman: "person",
  gentlemen: "people",
};
const GENDERED = new RegExp(`${EDGE}(?:${Object.keys(NEUTRAL).join("|")})${END}`, "giu");
const REGION = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * The <profile>, <company> and <evidence> blocks of one person: six fields and at most five
 * excerpts of 500 characters, each text scrubbed (above); an empty text is null, an empty excerpt
 * is dropped. The country is its English name with its code, `Germany (DE)`.
 */
export function anonymizeForAssessment(
  person: AnonymizerPerson,
  company: AnonymizerCompany | null,
  evidence: readonly string[] = [],
): Anonymized {
  const scrub = scrubber([person.firstName, person.lastName]);
  const own = (text: string | null | undefined) => scrub(text, true);
  const excerpts = evidence.slice(0, EXCERPTS).map((text) => own(text)?.slice(0, EXCERPT).trim());
  return {
    profile: {
      headline: own(person.headline),
      title: own(person.title),
      country: countryOf(person.locationCountry),
    },
    company: {
      name: scrub(company?.name, false),
      industry: scrub(company?.industry, false),
      size: scrub(company?.sizeRange, false),
    },
    evidence: excerpts.filter((text): text is string => Boolean(text)),
  };
}

/** The scrub for one person: links, addresses and names always; pronouns, gender and age in `own` texts. */
function scrubber(names: readonly (string | null | undefined)[]) {
  const parts = names.flatMap((name) => (name ?? "").normalize("NFC").split(/[\s'’-]+/));
  const variants = parts.flatMap((part) => [part, part.normalize("NFD").replace(/\p{M}/gu, "")]);
  const kept = [...new Set(variants.filter((part) => /\p{L}.*\p{L}/u.test(part)))];
  const escaped = kept.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const name =
    escaped.length > 0 ? new RegExp(`${EDGE}(?:${escaped.join("|")})${END}`, "giu") : null;
  return (value: string | null | undefined, own: boolean): string | null => {
    let text = (value ?? "").normalize("NFC").slice(0, READ);
    text = text.replace(LINK, "[link]").replace(EMAIL, "[email]");
    if (name) text = text.replace(name, "[name]");
    if (own) {
      text = text.replace(PRONOUNS, " ").replace(HONORIFIC, " ").replace(AGE, " ");
      text = text.replace(GENDERED, neutral);
    }
    text = text.replace(/\(\s*\)/g, " ").replace(/\s+/g, " ");
    // What a removal leaves: separators in a row, or after a sentence's end, become the first.
    text = text.replace(/([|·•,;/.!?:])(?:\s*[|·•,;/])+/g, "$1");
    text = text.replace(/^[\s|,;·•/–—-]+|[\s|,;·•/–—-]+$/g, "");
    return text === "" ? null : text;
  };
}

function neutral(word: string): string {
  const swap = NEUTRAL[word.toLowerCase()] ?? "";
  const upper = word[0] !== undefined && word[0] !== word[0].toLowerCase();
  return upper ? swap.charAt(0).toUpperCase() + swap.slice(1) : swap;
}

function countryOf(code: string | null | undefined): string | null {
  const upper = code?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  const name = REGION.of(upper);
  return name && name !== upper ? `${name} (${upper})` : upper;
}
