// The Brave adapter of the web-search port (README.md): Brave's Search API, its web search, over
// Node's fetch from this folder only (client.ts); no SDK. A search asks Brave for `count` results of
// the query, with the site: operator when the search names a site, Brave's country and search_lang
// when it names ones Brave takes (else without that filter) and its offset for a further page, and maps Brave's web results to
// the port's words: an https link, the title and the description as plain text, each cut to the
// port's length; a result off https, off the site or off Brave's documented shape is left out
// (README.md "Mapping"). No retry: the caller's activity retries by the code's kind.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { PAGE_MIN, TEXT_MAX } from "../constants.ts";
import { type WebResult, webResult, webSearchPort } from "../port.ts";
import { onSite } from "../site.ts";
import { braveClient, providerError } from "./client.ts";
import { braveConfig } from "./config.ts";
import {
  BASE_URL,
  COUNTRIES,
  ENTITIES,
  ENTITY,
  LANGUAGE_NAMES,
  LANGUAGES,
  SITE_OPERATOR,
  SPACES,
  TAG,
  TIMEOUT_MS,
} from "./constants.ts";

export type BraveOptions = {
  readonly apiKey: string;
  /** BASE_URL; a test passes its loopback server. */
  readonly baseUrl?: string;
  /** The clock a Retry-After date is read against; a test sets it. */
  readonly now?: () => number;
  /** How long a search may take, TIMEOUT_MS unless a test sets it. */
  readonly timeoutMs?: number;
};

/** Brave's answer, as far as the adapter reads it: the web results, absent when there are none. */
const braveAnswer = z.object({
  web: z.object({ results: z.array(z.unknown()) }).nullish(),
});
const braveResult = z.object({
  url: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
});

export function braveWebSearch({
  apiKey,
  baseUrl = BASE_URL,
  now = Date.now,
  timeoutMs = TIMEOUT_MS,
}: BraveOptions): PortImplementation<typeof webSearchPort> {
  const search = braveClient(baseUrl, apiKey, now, timeoutMs);
  return {
    searchWeb: async ({ query, site, count, country, language, page = PAGE_MIN }) => {
      const q = site === undefined ? query : `${query} ${SITE_OPERATOR}${site}`;
      const searchLang = language === undefined ? undefined : languageOf(language);
      const { status, json } = await search({
        q,
        count,
        ...(country !== undefined && COUNTRIES.has(country) ? { country } : {}),
        ...(searchLang === undefined ? {} : { searchLang }),
        ...(page > PAGE_MIN ? { offset: page - PAGE_MIN } : {}),
      });
      const answer = braveAnswer.safeParse(json);
      if (!answer.success) {
        throw providerError({ status, reason: "an answer off the documented shape" });
      }
      const results = (answer.data.web?.results ?? []).flatMap((raw) => {
        const result = resultOf(raw);
        return result && (site === undefined || onSite(result.url, site)) ? [result] : [];
      });
      return { results: results.slice(0, count) };
    },
  };
}

export const braveAdapter = defineAdapter(webSearchPort, {
  name: "brave",
  requires: ["BRAVE_API_KEY"],
  allowance: braveConfig.BRAVE_ALLOWANCE,
  create: () => {
    const { BRAVE_API_KEY: apiKey } = braveConfig;
    if (!apiKey) {
      const variables = ["BRAVE_API_KEY: required by the brave adapter"];
      throw new AppError("config_invalid", { details: { block: "packages/providers", variables } });
    }
    return braveWebSearch({ apiKey });
  },
});

/** Brave's code for a language of the port's, or undefined when Brave has none: no filter. */
function languageOf(language: string): string | undefined {
  return LANGUAGE_NAMES.get(language) ?? (LANGUAGES.has(language) ? language : undefined);
}

/** One of Brave's web results in the port's words, or undefined when its link is not one the port takes. */
function resultOf(raw: unknown): WebResult | undefined {
  const parsed = braveResult.safeParse(raw);
  if (!parsed.success || !webResult.shape.url.safeParse(parsed.data.url).success) return undefined;
  const { url, title, description } = parsed.data;
  return { url, title: textOf(title), snippet: textOf(description) };
}

/** Plain text: the markup dropped, the entities decoded, the spaces folded, cut to TEXT_MAX. */
function textOf(html: string | null | undefined): string {
  const text = (html ?? "")
    .replace(TAG, "")
    .replace(ENTITY, (entity) => ENTITIES.get(entity) ?? entity)
    .replace(SPACES, " ")
    .trim();
  if (text.length <= TEXT_MAX) return text;
  const cut = text.slice(0, TEXT_MAX);
  // Never half a character: a high surrogate at the cut goes with its pair.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
