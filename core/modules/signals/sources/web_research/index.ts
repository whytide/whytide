// The web_research kind (README.md "Kinds"; gamma-wr-030, the brief's "a source that needs no LinkedIn
// account"): what to look for on the web, not on LinkedIn, for an agent. No sender account, no page
// read through one, and no fire time of its own: the daily tick writes its run every
// SIGNALS_RESEARCH_EVERY_DAYS days (domain/schedule/research.ts), and Run now writes one at once. Its
// run is the workflow signals_research_run. Stored canonical: the words one space apart, the start
// pages as URLs, nothing for a field left empty.
import { z } from "zod";
import { defineSourceKind, LOOKBACK_DAYS_MAX } from "../_contract.ts";
import { LINK_MAX_CHARS } from "../constants.ts";
import {
  FOCUS,
  LANGUAGES,
  LANGUAGES_MAX,
  LINKEDIN_DOMAINS,
  NEVER_FETCHED_HOSTS,
  REGION_MAX_CHARS,
  START_PAGES_MAX,
} from "./constants.ts";

/** A text with its words one space apart. */
const squeezed = (value: string): string =>
  value
    .split(/\s+/u)
    .filter((word) => word !== "")
    .join(" ");

const focus = z
  .string()
  .max(FOCUS.max * 2)
  .transform((value, context) => {
    const text = squeezed(value);
    const length = [...text].length;
    if (length >= FOCUS.min && length <= FOCUS.max) return text;
    context.addIssue({ code: "custom", message: `${FOCUS.min} to ${FOCUS.max} characters` });
    return z.NEVER;
  });

const region = z
  .string()
  .max(REGION_MAX_CHARS * 2)
  .transform((value, context) => {
    const text = squeezed(value);
    if ([...text].length <= REGION_MAX_CHARS) return text === "" ? undefined : text;
    context.addIssue({ code: "custom", message: `${REGION_MAX_CHARS} characters at most` });
    return z.NEVER;
  })
  .optional();

const languages = z
  .array(z.string())
  .transform((given, context) => {
    const codes = given.map((code) => code.trim().toLowerCase());
    const distinct = new Set(codes).size === codes.length;
    if (distinct && codes.length <= LANGUAGES_MAX && codes.every((c) => LANGUAGES.includes(c))) {
      return codes.length === 0 ? undefined : codes;
    }
    context.addIssue({ code: "custom", message: `${LANGUAGES_MAX} distinct ISO 639-1 codes` });
    return z.NEVER;
  })
  .optional();

/** Whether the host is the domain or one of its subdomains. */
const underDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/**
 * The address as stored, or null when it is no start page: https only, no user, no password, no port
 * (the raw text is read too, since a default port is dropped by the parser), not LinkedIn's by
 * name and not a social network's.
 */
export function startPageOf(value: string): string | null {
  const text = value.trim();
  const authority = /^https:\/\/([^/?#]*)/iu.exec(text)?.[1];
  if (authority === undefined || text.length > LINK_MAX_CHARS) return null;
  if (authority.includes("@") || /:\d*$/u.test(authority)) return null;
  const url = URL.parse(text);
  if (url === null || url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/u, "");
  const refused = [...LINKEDIN_DOMAINS, ...NEVER_FETCHED_HOSTS];
  if (host === "" || refused.some((domain) => underDomain(host, domain))) return null;
  url.hash = "";
  return url.href;
}

const startPages = z
  .array(z.string())
  .max(START_PAGES_MAX * 2)
  .transform((given, context) => {
    const pages = given.map(startPageOf);
    const kept = [...new Set(pages)];
    if (!pages.includes(null) && kept.length <= START_PAGES_MAX) {
      return kept.length === 0 ? undefined : (kept as string[]);
    }
    context.addIssue({ code: "custom", message: `${START_PAGES_MAX} https addresses` });
    return z.NEVER;
  })
  .optional();

export const configSchema = z
  .strictObject({ focus, region, languages, startPages })
  .transform((config) => {
    // A field left empty is not stored, so that the config parses to itself.
    const { focus, region, languages, startPages } = config;
    return {
      focus,
      ...(region === undefined ? {} : { region }),
      ...(languages === undefined ? {} : { languages }),
      ...(startPages === undefined ? {} : { startPages }),
    };
  });
export type WebResearchConfig = z.output<typeof configSchema>;

export const webResearch = defineSourceKind<WebResearchConfig>(
  {
    kind: "web_research",
    configSchema,
    labelKey: "signals.kinds.web_research.label",
    lookbackDays: LOOKBACK_DAYS_MAX,
    // No fire time of its own: the daily tick writes the run (README.md "Runs").
    schedule: () => [],
    cadence: "research",
    reader: { research: true },
    readsThroughAccount: false,
    configEditable: true,
    event: { kind: "web_research" },
    // A page names the people the research finds; the steps that read them come with gamma-wr-060.
    evidenceOf: (candidate) => ({
      url: candidate.objectUrl,
      reaction: candidate.reaction,
      author: candidate.name,
    }),
  },
  import.meta.url,
);
