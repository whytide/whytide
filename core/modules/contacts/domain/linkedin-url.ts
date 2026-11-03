// The URL rules (docs/concepts.md "Normalized URL"): a person is keyed on its LinkedIn profile,
// https://linkedin.com/in/<slug> lowercased, whatever scheme, `www.`, case, query, fragment or
// trailing slash it arrived with; anything else is no profile. A company is keyed on its LinkedIn
// page the same way, or on its domain.
const HOSTS = new Set(["linkedin.com", "www.linkedin.com"]);
/** A handle as the LinkedIn adapter reads one: letters, digits, `_`, `-` and percent escapes. */
const SLUG = /^[\w%-]{1,200}$/;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;

/** A LinkedIn profile URL as contacts keys a person, `https://linkedin.com/in/<slug>`, or null. */
export function normalizeLinkedinUrl(url: string): string | null {
  const slug = linkedinSlug(url, "in");
  return slug === null ? null : `https://linkedin.com/in/${slug}`;
}

/** A LinkedIn company page as contacts keys a company, `https://linkedin.com/company/<slug>`, or null. */
export function normalizeCompanyLinkedinUrl(url: string): string | null {
  const slug = linkedinSlug(url, "company");
  return slug === null ? null : `https://linkedin.com/company/${slug}`;
}

/** A company's domain, lowercased, without a scheme, `www.`, a port or a path, or null. */
export function normalizeDomain(value: string): string | null {
  const host = httpUrl(value)?.hostname.replace(/^www\./, "");
  return host !== undefined && DOMAIN.test(host) ? host : null;
}

/** The one path segment after `/<section>/` of a URL on linkedin.com, lowercased, or null. */
function linkedinSlug(value: string, section: "in" | "company"): string | null {
  const url = httpUrl(value);
  if (url === null || !HOSTS.has(url.hostname)) return null;
  if (url.port !== "" || url.username !== "" || url.password !== "") return null;
  const [, first, slug, ...rest] = url.pathname.toLowerCase().split("/");
  const trailing = rest.length === 0 || (rest.length === 1 && rest[0] === "");
  return first === section && slug !== undefined && SLUG.test(slug) && trailing ? slug : null;
}

/** The value as an http or https URL, https assumed when it names no scheme, or null. */
function httpUrl(value: string): URL | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || text.length > 2048) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
