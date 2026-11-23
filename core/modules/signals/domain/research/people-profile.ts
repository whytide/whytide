// A picked person's LinkedIn profile by one web search (README.md "Web research"; gamma-wr-070), for a
// person whose page printed no key. The owner's exception of 2026-11-16: this one search holds a
// person's name, with the company's name and nothing else about the person; no other query of the run
// does. It goes through enrichment's counted search, limited to linkedin.com, with the company's
// country, inside SIGNALS_RESEARCH_SEARCHES_PER_RUN. Code decides which result is the person's, not
// the AI: its address is a profile's (`normalizeLinkedinUrl`, compared and never fetched: no request
// goes to linkedin.com) and its title and snippet name both the person and the company, names cleaned
// as enrichment cleans them (`normalName`). Two different profiles that pass: none is taken. The
// name stays in memory: the query is in no log line, span, metric or history, and the results go to
// the run's files (raw/ 72 hours), read again by a step run again, which never searches twice.
import { normalizeLinkedinUrl } from "@whytide/contacts";
import { normalName, searchWeb } from "@whytide/enrichment";
import type { WebResult } from "@whytide/providers";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef, writeRunFile } from "../runs.ts";
import { searchRoom } from "./candidates.ts";
import { holdsContact } from "./checks.ts";
import {
  COUNT_ADAPTERS_SPENT,
  COUNT_SEARCHES_ASKED,
  COUNT_SEARCHES_FAILED,
  COUNT_SEARCHES_REFUSED_CONTACT,
  PROFILE_RESULTS_COUNT,
  PROFILE_SITE,
} from "./constants.ts";
import { profileKey, readJsonFile } from "./files.ts";

/** Whom to look for: the person's name, the company's name and country, the person's place in the pick. */
export type ProfileAsk = {
  readonly foundCompanyId: string;
  readonly n: number;
  readonly name: string;
  readonly companyName: string;
  readonly country: string | null;
};
/** The profile, or null; `stop` when no further search may be asked in this run (its limit, or every adapter spent). */
export type ProfileFound = { readonly profile: string | null; readonly stop?: true };

/** A letter or a digit: what a name may not touch on either side inside a longer word. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whether `text` holds `name` as whole words (both already cleaned). */
export function holds(text: string, name: string): boolean {
  if (name === "") return false;
  for (let from = text.indexOf(name); from !== -1; from = text.indexOf(name, from + 1)) {
    const before = text[from - 1];
    const after = text[from + name.length];
    if (
      (before === undefined || !WORD_CHAR.test(before)) &&
      (after === undefined || !WORD_CHAR.test(after))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The person's profile among a search's results: the one address that is a profile's and whose title
 * and snippet name both the person and the company; null for none, or for two different ones.
 */
export function profileOf(
  results: readonly Pick<WebResult, "url" | "title" | "snippet">[],
  name: string,
  companyName: string,
): string | null {
  const person = normalName(name);
  const company = normalName(companyName);
  const passing = new Set<string>();
  for (const { url, title, snippet } of results) {
    const profile = normalizeLinkedinUrl(url);
    if (profile === null) continue;
    const text = normalName(`${title} ${snippet}`);
    if (holds(text, person) && holds(text, company)) passing.add(profile);
  }
  const [only, ...more] = [...passing];
  return only !== undefined && more.length === 0 ? only : null;
}

/** The query: the person's name and the company's, each quoted, never a quote inside. */
const queryOf = (name: string, companyName: string): string =>
  `"${name.replaceAll('"', "")}" "${companyName.replaceAll('"', "")}"`;

/**
 * The person's profile by search. A file the step wrote before answers without a search; else the
 * run's searches' limit is read (`budget_reached` is set once at it), the query is refused when it
 * holds a contact, and the counted search is asked once, its results kept as a file.
 */
export async function searchProfile(
  ref: RunRef,
  ask: ProfileAsk,
  tenant: TenantRun,
): Promise<ProfileFound> {
  const { workspaceId, runId } = ref;
  const { name, companyName } = ask;
  const key = profileKey(runId, ask.foundCompanyId, ask.n);
  const filed = (await readJsonFile(workspaceId, key)) as { results?: WebResult[] } | null;
  if (filed !== null) return { profile: profileOf(filed.results ?? [], name, companyName) };
  if (!(await tenant(() => searchRoom(runId)))) return { profile: null, stop: true };
  const query = queryOf(name, companyName);
  if (holdsContact(query)) {
    await tenant(() => addCounts(runId, { [COUNT_SEARCHES_REFUSED_CONTACT]: 1 }));
    return { profile: null };
  }
  const searched = await searchWeb({
    ...{ query, site: PROFILE_SITE, count: PROFILE_RESULTS_COUNT },
    ...(ask.country === null ? {} : { country: ask.country }),
  });
  if (searched.status === "no_adapter") return { profile: null, stop: true };
  if (searched.status === "spent") {
    await tenant(() => addCounts(runId, { [COUNT_ADAPTERS_SPENT]: 1 }));
    return { profile: null, stop: true };
  }
  if (searched.status === "failed") {
    await tenant(() => addCounts(runId, { [COUNT_SEARCHES_FAILED]: 1 }));
    return { profile: null };
  }
  await writeRunFile(workspaceId, key, { adapter: searched.adapter, results: searched.results });
  await tenant(() => addCounts(runId, { [COUNT_SEARCHES_ASKED]: 1 }));
  return { profile: profileOf(searched.results, name, companyName) };
}
