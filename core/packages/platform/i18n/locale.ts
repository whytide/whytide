import { platformConfig } from "../config/platform.ts";
import { AppError } from "../errors/index.ts";
import { errors } from "./errors.ts";

/** An Accept-Language header is untrusted input: what is read of it is capped. */
const MAX_HEADER = 512;
const MAX_TAGS = 20;

/** The locale when neither the user's setting nor the browser names one: `DEFAULT_LOCALE`, `en` unless the environment says otherwise. */
export function defaultLocale(): string {
  return canonicalLocale(platformConfig.DEFAULT_LOCALE);
}

/** The canonical BCP 47 tag (`en-GB`), or `invalid_locale`: a locale reaches a file name, so nothing else passes. */
export function canonicalLocale(tag: string): string {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    if (canonical) return canonical;
  } catch {
    // not a language tag: reported below
  }
  throw new AppError(errors.invalid_locale, { details: { locale: tag.slice(0, 64) } });
}

/**
 * `zh-Hant-TW` gives `["zh-Hant-TW", "zh-Hant", "zh"]`: the language, script and region of a tag,
 * then each shorter prefix. Variants and extensions (`-u-nu-thai`) are left out, so the first entry
 * is the bare tag.
 */
export function localeChain(tag: string): string[] {
  const { language, script, region } = new Intl.Locale(tag);
  const parts = [language, script, region].filter((part): part is string => part !== undefined);
  return parts.map((_, index) => parts.slice(0, parts.length - index).join("-"));
}

export type ResolveOptions = {
  /** The locales that have messages; the fallback alone when unset. */
  readonly available?: readonly string[];
  /** The last resort; `DEFAULT_LOCALE` when unset. */
  readonly fallback?: string;
};

/**
 * The user's setting, then the browser's Accept-Language, then the default: the first tag one of
 * whose prefixes (`zh-Hant-TW`, `zh-Hant`, `zh`) has messages. The result is `language[-script][-region]`
 * of that tag: the region is kept, so `en-GB` reads British dates, and no extension reaches `Intl`.
 */
export function resolveLocale(
  userSetting?: string | null,
  acceptLanguage?: string | null,
  options: ResolveOptions = {},
): string {
  const fallback = options.fallback ?? defaultLocale();
  const available = new Set((options.available ?? [fallback]).map(canonicalLocale));
  for (const candidate of [userSetting ?? "", ...acceptLanguageTags(acceptLanguage ?? "")]) {
    if (!candidate) continue;
    let chain: string[];
    try {
      chain = localeChain(canonicalLocale(candidate));
    } catch {
      continue;
    }
    if (chain.some((prefix) => available.has(prefix))) return chain[0] ?? fallback;
  }
  return fallback;
}

/** The tags of an Accept-Language header by preference: `*` and an entry with a quality that is not a number above 0 are left out. */
function acceptLanguageTags(header: string): string[] {
  return header
    .slice(0, MAX_HEADER)
    .split(",")
    .slice(0, MAX_TAGS)
    .map((entry, index) => {
      const [tag = "", ...params] = entry.trim().split(";");
      const q = params.map((p) => /^\s*q=(.*?)\s*$/i.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((e) => e.tag !== "" && e.tag !== "*" && Number.isFinite(e.q) && e.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((e) => e.tag);
}
