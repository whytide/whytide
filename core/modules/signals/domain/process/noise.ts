// The noise rules (README.md "Processing"; gamma-p5-030), plain functions: the staff of the
// workspace's competitors are dropped before any read slot, credit or profile read where the staged
// headline already tells, and again on the read profile, before the hard filters. Recruiters and job
// seekers by their staged headline only where the triage could not answer, or in a run started
// before it (signals-triage-ai): after the read, the assessment judges them. A rule the audience
// names is off: an ICP whose titles hold "Recruiter" keeps recruiters. The terms are config.ts's,
// English only, matched as whole words in any case.
import { NOISE_JOB_SEEKER_PHRASES, NOISE_RECRUITER_TERMS } from "../../config.ts";
import { EDGE, wordsOf } from "./rules.ts";

/** The kind whose sources name the workspace's competitors (gamma-p5-025), by its name. */
export const COMPETITOR_KIND = "competitor_engagement";
/** The drop reasons of the noise rules, in the order they are checked. */
export const NOISE_REASONS = [
  "dropped_recruiter",
  "dropped_job_seeker",
  "dropped_competitor",
] as const;
export type NoiseReason = (typeof NOISE_REASONS)[number];

/** Whom the workspace sells to, as the rules spare it: the ICP's titles and must-haves. */
export type NoiseAudience = { readonly titles: readonly string[]; readonly mustHaves: string };
/** A competitor, as a competitor_engagement source's config names it: its name and its page. */
export type Competitor = { readonly name: string; readonly pageUrl: string | null };
/** A read profile, as the rule after the read looks at it. */
export type NoiseProfile = {
  readonly headline: string;
  readonly companyName: string;
  readonly companyUrl?: string | undefined;
};
export type NoiseRules = {
  /** Before the read, the three rules: the staged headline's reason, or null. */
  readonly headline: (headline: string) => NoiseReason | null;
  /** Before the read of a triaged run, the competitor's rule alone: the headline's reason, or null. */
  readonly competitor: (headline: string) => "dropped_competitor" | null;
  /** After the read, the competitor's rule: the profile's reason, or null. */
  readonly profile: (profile: NoiseProfile) => "dropped_competitor" | null;
};

/**
 * The rules of an audience and its competitors. Recruiter: a term in the headline, off when the
 * audience's titles hold one. Job seeker: a phrase in the headline, off when the audience's titles or
 * must-haves hold one, or "job seeker". Competitor, never off: its name after "at" or "@" in the
 * headline; after the read, also the profile's company by its name or its page, in any case.
 */
export function noiseRules(
  audience: NoiseAudience,
  competitors: readonly Competitor[],
): NoiseRules {
  const recruiter = holds(NOISE_RECRUITER_TERMS, "s?");
  const seeker = holds(NOISE_JOB_SEEKER_PHRASES, "");
  const seekerWords = holds(["job seeker"], "s?");
  const recruitersWanted = audience.titles.some(recruiter);
  const audienceTexts = [...audience.titles, audience.mustHaves];
  const seekersWanted = audienceTexts.some((text) => seeker(text) || seekerWords(text));
  const named = competitors.map(({ name }) => name.trim()).filter((name) => [...name].length >= 2);
  const atCompetitor =
    named.length === 0
      ? () => false
      : patternTest(`(?:(?<!${EDGE})at\\s+|@\\s*)(?:${named.map(wordsOf).join("|")})(?!${EDGE})`);
  const names = new Set(named.map(folded));
  const pages = new Set(competitors.flatMap(({ pageUrl }) => pageOf(pageUrl) ?? []));
  const competitor = (text: string): "dropped_competitor" | null =>
    atCompetitor(text) ? "dropped_competitor" : null;
  return {
    headline(text) {
      if (!recruitersWanted && recruiter(text)) return "dropped_recruiter";
      if (!seekersWanted && seeker(text)) return "dropped_job_seeker";
      return competitor(text);
    },
    competitor,
    profile({ headline, companyName, companyUrl }) {
      const page = pageOf(companyUrl);
      const atOne = names.has(folded(companyName)) || (page !== null && pages.has(page));
      return atOne || atCompetitor(headline) ? "dropped_competitor" : null;
    },
  };
}

/** The competitors of competitor_engagement sources' configs, `{ companyName, companyUrl }`. */
export function competitorsOf(configs: readonly unknown[]): Competitor[] {
  return configs.flatMap((config) => {
    const { companyName, companyUrl } =
      typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
    const name = typeof companyName === "string" ? companyName : "";
    const pageUrl = typeof companyUrl === "string" ? companyUrl : null;
    return name.trim() === "" && pageUrl === null ? [] : [{ name, pageUrl }];
  });
}

/** Whether a text holds one of the terms as whole words in any case, `suffix` after any of them. */
function holds(terms: readonly string[], suffix: string): (text: string) => boolean {
  return patternTest(`(?<!${EDGE})(?:${terms.map(wordsOf).join("|")})${suffix}(?!${EDGE})`);
}

function patternTest(source: string): (text: string) => boolean {
  const pattern = new RegExp(source, "iu");
  return (text) => pattern.test(text);
}

/** A company's name as compared: trimmed, single spaces, lower case. */
const folded = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** A company page as compared: its host (linkedin.com for any of LinkedIn's) and path, lower case. */
function pageOf(url: string | null | undefined): string | null {
  const text = url?.trim() ?? "";
  if (text === "") return null;
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    const host = parsed.hostname.toLowerCase();
    const site = /(?:^|\.)linkedin\.com$/.test(host) ? "linkedin.com" : host.replace(/^www\./, "");
    return `${site}${parsed.pathname.toLowerCase().replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}
