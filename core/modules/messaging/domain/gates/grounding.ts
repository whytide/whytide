// The grounding gate (docs/security.md "The gates"; security §6, briefs RB-10.2.1, reduced: entity
// matching in code, no model verifier). extractEntities finds a text's dates, numbers and
// capitalized names (people, companies, tools, places, titles). A name must be found, as whole
// words after normalizeEntity, in a value of the dossier's entities, a link's and a date's aside,
// or in the text of one of its claims and quotes; a number in a number entity or a claim only; a
// date must name a day of the dossier's dates or be found as a name is. Unmatched, it fails, named.
// Lenient on accents, case and spacing; a name in lower case or a number in words is not seen
// (README.md "Decided here"). Pure.
import type { Dossier } from "../../schemas/dossier.ts";
import type { GateIssue } from "../../schemas/writer.ts";
import { normalizeEntity } from "../dossier/entities.ts";

export type Extracted = { readonly kind: "date" | "number" | "name"; readonly text: string };
type DateRef = { year?: number; month?: number; day?: number; weekday?: number };

/** A text as the gates compare it: normalized, "1,900" as 1900, every mark but letters a space. */
export function words(text: string): string {
  return normalizeEntity(text)
    .replace(/(\p{N}),(?=\p{N}{3}(?!\p{N}))/gu, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const WEEKDAYS = "sunday monday tuesday wednesday thursday friday saturday".split(" ");
// Capitalized, as English writes them; a bare "May" is the verb.
const MONTH =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?!\\p{L})\\.?";
const BARE_MONTH = MONTH.replace("|May|", "|");
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "(?:,?\\s+(\\d{4}))?";
const monthOf = (name = "") => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
const number = (digits?: string) => (digits === undefined ? undefined : Number(digits));
const DATES: readonly [RegExp, (m: RegExpMatchArray) => DateRef][] = [
  [/\b(\d{4})-(\d{2})-(\d{2})\b/gu, (m) => ({ year: +m[1]!, month: +m[2]!, day: +m[3]! })],
  [
    new RegExp(`\\b${MONTH}\\s+${DAY}\\b${YEAR}`, "gu"),
    (m) => ({ month: monthOf(m[1]), day: number(m[2]), year: number(m[3]) }),
  ],
  [
    new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}${YEAR}`, "gu"),
    (m) => ({ day: number(m[1]), month: monthOf(m[2]), year: number(m[3]) }),
  ],
  [new RegExp(`\\b${BARE_MONTH}`, "gu"), (m) => ({ month: monthOf(m[1]) })],
  [
    /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/gu,
    (m) => ({ weekday: WEEKDAYS.indexOf(m[1]!.toLowerCase()) }),
  ],
];
const NUMBER = /(?<![\p{L}\p{N}_])\p{N}+(?:[.,:/-]\p{N}+)*/gu;
const TOKEN = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}]|['’&.-](?=[\p{L}\p{N}]))*/gu;
const CAPITAL = /^(?:\p{Lu}|\p{Ll}+\p{Lu})/u;
/** Between two capitalized words of one name: spaces, or the small words of "Head of Data". */
const JOIN = /^\s+(?:(?:of|and|for|the|de|da|do|van|von|der|&)\s+)*$/u;
/** The text before a word that starts a sentence or a clause: nothing, a mark, or a new line. */
const SENTENCE_START = /(?:^|[.!?:;,]["'”’)\]]*\s+|\n)\s*["'“‘(\[]*$/u;
const SMALL = /^(?:of|and|for|the|de|da|do|van|von|der)$/u;
/** Never a name: the pronoun, the channel's own name, a postscript, a trade's acronyms. */
const ALWAYS = new Set(
  `i i'm i've i'd i'll linkedin ps p.s re fw fwd ai ml api b2b b2c saas crm roi kpi kpis okr okrs
  gtm icp mql mqls sdr sdrs bdr bdrs ae aes vp svp evp ceo cto cfo coo cmo cro revops`.split(/\s+/),
);
/** Words a sentence starts with that are not names: dropped there, kept anywhere else. */
const COMMON = new Set(
  `a an the we we're we've you you're your our my me us they their them he she his her it it's its
  this that these those there here hi hello hey dear greetings thanks thank cheers best regards kind
  warm congrats congratulations and but or so also as at by for from in into of on to with without
  about after before since while when where what why how who which whether if because though
  although no not yes yet still just only even really quite very most more many much some any all
  every each both either is are was were be been am do does did have has had can could will would
  should may might must saw seen noticed read loved love liked like enjoyed found came caught
  curious wondering wanted want hoping hope looking thought think great good nice glad happy keen excited
  interesting impressive cool awesome amazing fantastic wow quick short one two first last next
  another other same let let's please sorry welcome sure ok okay absolutely exactly perhaps maybe
  worth open feel free then than once until unless already always never often usually recently
  lately currently today now soon honestly reaching writing sharing helping building working
  running see seeing seems sounds feels guess imagine know team teams sales leads companies folks
  people founders leaders`.split(/\s+/),
);

/** The text's dates, then its numbers, then its names; each one's span is blanked once taken. */
export function extractEntities(text: string): Extracted[] {
  const found: Extracted[] = [];
  let rest = text;
  for (const [pattern] of DATES) {
    rest = rest.replace(pattern, (match) => {
      found.push({ kind: "date", text: match });
      return " ".repeat(match.length);
    });
  }
  rest = rest.replace(NUMBER, (match) => {
    found.push({ kind: "number", text: match });
    return " ".repeat(match.length);
  });
  for (const name of names(rest)) found.push({ kind: "name", text: name });
  return found;
}

/** Runs of capitalized words, a run that starts a sentence without its common first word. */
function names(text: string): string[] {
  const runs: { start: number; end: number; words: string[] }[] = [];
  let run: (typeof runs)[number] | undefined;
  for (const match of text.matchAll(TOKEN)) {
    const [word] = match;
    const start = match.index;
    const lower = word.toLowerCase().replaceAll("’", "'").replace(/'s$/u, "");
    const initial = SENTENCE_START.test(text.slice(0, start));
    if (!CAPITAL.test(word) || ALWAYS.has(lower) || (initial && COMMON.has(lower))) {
      // A small word may join two capitalized ones: JOIN reads the gap when the next one comes.
      if (!SMALL.test(word)) run = undefined;
      continue;
    }
    if (run !== undefined && !initial && JOIN.test(text.slice(run.end, start))) {
      run.end = start + word.length;
      run.words.push(word);
    } else {
      run = { start, end: start + word.length, words: [word] };
      runs.push(run);
    }
    // A possessive ends its name: "Acme's Head of Data" is Acme, then Head of Data.
    if (/['’]s$/u.test(word)) run = undefined;
  }
  return runs.map(({ start, end }) => text.slice(start, end).replace(/['’]s?$/u, ""));
}

/** Every extracted entity the dossier does not hold, named as the text wrote it, each once. */
export function groundingIssues(text: string, dossier: Dossier): GateIssue[] {
  const { entities, facts } = dossier;
  const valuesOf = (kinds: readonly string[]) =>
    facts.filter(({ kind }) => kinds.includes(kind)).map(({ value }) => value);
  // A date is matched by its day, below; a link's words and digits ground nothing.
  const named = entities.filter(({ kind, value }) => kind !== "date" && !/^\w+:\/\//u.test(value));
  const held = [...named.map(({ value }) => value), ...valuesOf(["claim", "quote"])];
  // A number only as the dossier gives numbers: a date's month or a post's id is no figure.
  const numbers = [...valuesOf(["number"]), ...valuesOf(["claim"])];
  const days = entities
    .filter((entity) => entity.kind === "date")
    .map((entity) => new Date(`${entity.value}T00:00:00Z`));
  const within = (values: readonly string[]) => {
    const spaced = values.map((value) => ` ${words(value)} `);
    return (value: string) => {
      const wanted = words(value);
      return wanted !== "" && spaced.some((text) => text.includes(` ${wanted} `));
    };
  };
  const found = within(held);
  const figure = within(numbers);
  const ungrounded = extractEntities(text).filter((entity) => {
    if (entity.kind === "number") return !figure(entity.text);
    if (found(entity.text)) return false;
    // A name of several words is grounded whole, or each of its capitalized words ("Ines and Sam").
    if (entity.kind === "name") {
      return !entity.text
        .split(/\s+/u)
        .filter((part) => CAPITAL.test(part))
        .every(found);
    }
    const ref = dateRef(entity.text);
    return !days.some((day) => sameDay(ref, day));
  });
  return [...new Set(ungrounded.map((entity) => entity.text))].map((entity) => ({
    gate: "grounding",
    entity,
  }));
}

function dateRef(text: string): DateRef {
  for (const [pattern, read] of DATES) {
    const match = [...text.matchAll(pattern)][0];
    if (match !== undefined) return read(match);
  }
  return {};
}

function sameDay(ref: DateRef, day: Date): boolean {
  return (
    (ref.year === undefined || ref.year === day.getUTCFullYear()) &&
    (ref.month === undefined || ref.month === day.getUTCMonth() + 1) &&
    (ref.day === undefined || ref.day === day.getUTCDate()) &&
    (ref.weekday === undefined || ref.weekday === day.getUTCDay())
  );
}
