// The title rule of the hard filters (docs/concepts.md "Titles"), English only in alpha (RB-3.1.2,
// reduced): a title becomes tokens, and an ICP title matches when every one of its tokens is
// in the person's. tests/fixtures/titles.json documents it in fifty pairs; a change here changes them.

/** Words that name no role. */
const STOP_WORDS = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "the", "to"]);
/** Seniority noise: a level inside a role, never the role (seniority is the assessment's criterion). */
const NOISE = new Set(["senior", "sr", "snr", "junior", "jr", "interim", "acting"]);
/**
 * Synonyms and abbreviations, each phrase read as its canonical tokens. A role collapses to one token
 * (vice president is vp, so a vp is no president); a function's abbreviation expands to its words.
 */
const SYNONYMS: Readonly<Record<string, string>> = {
  "vice president": "vp",
  "v p": "vp",
  svp: "vp",
  evp: "vp",
  director: "head",
  dir: "head",
  "chief executive officer": "ceo",
  "chief technology officer": "cto",
  "chief technical officer": "cto",
  "chief financial officer": "cfo",
  "chief operating officer": "coo",
  "chief marketing officer": "cmo",
  "chief revenue officer": "cro",
  "chief information officer": "cio",
  "chief product officer": "cpo",
  "co founder": "founder",
  cofounder: "founder",
  sdr: "sales development representative",
  bdr: "business development representative",
  ae: "account executive",
  bd: "business development",
  "biz dev": "business development",
  bizdev: "business development",
  hr: "human resources",
  gm: "general manager",
  revops: "revenue operations",
  ops: "operations",
  mgr: "manager",
  rep: "representative",
};

/** Only a title outside ASCII needs its accents taken off (NFKD, then the marks dropped). */
const NOT_ASCII = /[^\x20-\x7e]/;

/** The phrases by their first token, longest first, so the longest phrase wins. */
const PHRASES = new Map<string, { from: string[]; to: string[] }[]>();
for (const [phrase, canonical] of Object.entries(SYNONYMS)) {
  const from = phrase.split(" ");
  const first = from[0] as string;
  PHRASES.set(first, [...(PHRASES.get(first) ?? []), { from, to: canonical.split(" ") }]);
}
for (const list of PHRASES.values()) list.sort((a, b) => b.from.length - a.from.length);

/** The ICP's titles as tokens, read once per ICP; a title with no token left is no constraint. */
export function icpTitleTokens(icpTitles: readonly string[]): string[][] {
  return icpTitles.map(titleTokens).filter((tokens) => tokens.length > 0);
}

/**
 * Whether a person's title can match one of the ICP's titles, as icpTitleTokens read them: it holds
 * every token of one of them. A title with no token left, or an ICP with no title, fits.
 */
export function titleFits(title: string, targets: readonly (readonly string[])[]): boolean {
  if (targets.length === 0) return true;
  const tokens = titleTokens(title);
  return (
    tokens.length === 0 || targets.some((target) => target.every((token) => tokens.includes(token)))
  );
}

/**
 * A title's tokens: lower case, accents gone, punctuation a space (`&`, `/`, `-`, `.`), stop words
 * and seniority noise dropped, the synonyms read. Empty when nothing of a role is left.
 */
function titleTokens(title: string): string[] {
  const plain = NOT_ASCII.test(title) ? title.normalize("NFKD").replace(/\p{M}/gu, "") : title;
  const words = (plain.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => !STOP_WORDS.has(word) && !NOISE.has(word),
  );
  const tokens: string[] = [];
  for (let at = 0; at < words.length; ) {
    const phrase = PHRASES.get(words[at] as string)?.find(({ from }) =>
      from.every((word, offset) => words[at + offset] === word),
    );
    tokens.push(...(phrase?.to ?? [words[at] as string]));
    at += phrase?.from.length ?? 1;
  }
  return tokens;
}
