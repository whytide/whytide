// What a company's site tells about its addresses (README "The sources reply, website and pattern";
// gamma-en-085), in memory and in code: the addresses at the company's domain in the pages' text and
// their `mailto:` links, role addresses left out; the lead's own, one whose local part is a pattern of
// the lead's names; and the domain's pattern, the one most of the other named addresses agree on. A
// local part of two names joined by `.`, `_` or `-` gives its pattern directly; any other one only
// when a full name within NAME_WINDOW characters of it on the page fits it. The other addresses and
// the names around them are dropped here: only the lead's own and a pattern's name leave. Pure.
import { atDomain } from "../lookup/key.ts";
import { addressesIn, localOf } from "./addresses.ts";
import {
  NAME_WINDOW,
  PATTERNS,
  type Pattern,
  SEPARATOR_PATTERNS,
  SITE_ADDRESSES_MAX,
} from "./constants.ts";
import { cleanName, type Names } from "./names.ts";
import { patternOf } from "./patterns.ts";
import { isRoleAddress } from "./roles.ts";

/** A page as the source reads it: its text and the addresses of its `mailto:` links. */
export type EmailPage = {
  readonly text: string;
  readonly mailto: readonly string[];
};
export type SiteAddresses = { readonly own: readonly string[]; readonly pattern: Pattern | null };

/** Two names joined by one separator, each two letters at least. */
const TWO_NAMES = /^([a-z]{2,})([._-])([a-z]{2,})$/;
/** A capitalised word of a name: a capital, then letters, marks, apostrophes or hyphens. */
const NAME_WORD = /\p{Lu}[\p{L}\p{M}'’-]*/gu;
/** Between two words of one name: spaces only, on one line. */
const NAME_GAP = /^[ \t ]{1,3}$/;

/** The lead's own addresses on the site and the domain's pattern, from the pages. */
export function readSiteAddresses(
  pages: readonly EmailPage[],
  domain: string,
  lead: Names,
): SiteAddresses {
  const seen = new Map<string, { text: string; at: number } | null>();
  for (const { text, mailto } of pages) {
    for (const { address, at } of addressesIn(text)) {
      if (!seen.get(address)) seen.set(address, { text, at });
    }
    for (const address of mailto) if (!seen.has(address)) seen.set(address, null);
  }
  const own: string[] = [];
  const votes = new Map<Pattern, number>();
  let read = 0;
  for (const [address, where] of seen) {
    if (read >= SITE_ADDRESSES_MAX) break;
    if (!atDomain(address, domain) || isRoleAddress(address)) continue;
    read += 1;
    const local = localOf(address);
    if (patternOf(local, lead) !== null) {
      own.push(address);
      continue;
    }
    const pattern = directPattern(local) ?? (where === null ? null : namedPattern(local, where));
    if (pattern !== null) votes.set(pattern, (votes.get(pattern) ?? 0) + 1);
  }
  return { own, pattern: mostVoted(votes) };
}

/** The pattern of two names joined by a separator: `john.smith` is `{first}.{last}`. */
function directPattern(local: string): Pattern | null {
  const separator = TWO_NAMES.exec(local)?.[2];
  return separator === undefined ? null : (SEPARATOR_PATTERNS[separator] ?? null);
}

/** The pattern a full name within NAME_WINDOW characters of the address gives its local part. */
function namedPattern(local: string, where: { text: string; at: number }): Pattern | null {
  const from = Math.max(0, where.at - NAME_WINDOW);
  const window = where.text.slice(from, where.at + local.length + 1 + NAME_WINDOW);
  for (const run of nameRuns(window)) {
    for (let i = 0; i < run.length - 1; i++) {
      for (let j = i + 1; j < run.length; j++) {
        const names = { first: cleanName(run[i] ?? ""), last: cleanName(run[j] ?? "") };
        const pattern = patternOf(local, names);
        if (pattern !== null) return pattern;
      }
    }
  }
  return null;
}

/** The runs of two capitalised words or more, each run a name's words in order. */
function nameRuns(text: string): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  let end = -1;
  for (const match of text.matchAll(NAME_WORD)) {
    const joined = end >= 0 && NAME_GAP.test(text.slice(end, match.index));
    if (!joined) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
    run.push(match[0]);
    end = match.index + match[0].length;
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/** The pattern most addresses agree on; a tie goes to the earlier in PATTERNS; null for none. */
function mostVoted(votes: ReadonlyMap<Pattern, number>): Pattern | null {
  let best: Pattern | null = null;
  for (const pattern of PATTERNS) {
    const count = votes.get(pattern) ?? 0;
    if (count > 0 && (best === null || count > (votes.get(best) ?? 0))) best = pattern;
  }
  return best;
}
