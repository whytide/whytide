// The post URL of a post_engagers source (README.md "Kinds"): https on linkedin.com, with or without
// www., in one of the forms LinkedIn links a post with: /posts/<author>_<words>-activity-<id>-<code>,
// or /feed/update/urn:li:activity:<id>; share and ugcPost in place of activity too. A profile, a
// company page or any other host is refused. The query and the fragment are dropped: a share link
// carries tracking ids, the sharer's among them (docs/rules/security.md §2). A short link, the Share
// button's https://lnkd.in/p/<code> or https://lnkd.in/<code>, is resolved at the create: one GET to
// it through fetchSafe, the platform's egress client, which answers its redirect unfollowed; the
// Location is read for the post's URL and never fetched (the app reads no LinkedIn page outside the
// person's connected account). Nothing here logs, and no error carries a URL.
import {
  AppError,
  type FetchSafeOptions,
  type FetchSafeResponse,
  fetchSafe,
  isAppError,
} from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import {
  REDIRECT_STATUSES,
  SHORT_LINK_HOST,
  SHORT_LINK_PATH,
  SHORT_LINK_REQUEST,
} from "./constants.ts";

const HOSTS = new Set(["linkedin.com", "www.linkedin.com"]);
const KIND = "(?:activity|share|ugcPost)";
const COLON = "(?::|%3[Aa])";
const POST_PATHS = [
  new RegExp(`^/posts/[\\w%.~-]+-${KIND}-\\d{1,30}-[\\w-]+/?$`),
  new RegExp(`^/feed/update/urn${COLON}li${COLON}${KIND}${COLON}\\d{1,30}/?$`),
];

/** One GET through fetchSafe: a short link's request, or a test's stub in its place. */
export type Get = (url: string, options: FetchSafeOptions) => Promise<FetchSafeResponse>;

/** The request the config schema makes; a test replaces `get` with node:test's mock.method. */
export const shortLinks: { get: Get } = { get: fetchSafe };

/** The post's URL as https://www.linkedin.com<path>, or null when `value` is not a LinkedIn post. */
export function canonicalPostUrl(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
  if (!plain || !HOSTS.has(url.hostname)) return null;
  if (!POST_PATHS.some((path) => path.test(url.pathname))) return null;
  return `https://www.linkedin.com${url.pathname}`;
}

/** The short link `value` is, as https://lnkd.in<path> without the query or the fragment; else null. */
export function shortLinkUrl(value: string): string | null {
  const url = URL.parse(value);
  if (url === null || url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  if (url.hostname !== SHORT_LINK_HOST || !SHORT_LINK_PATH.test(url.pathname)) return null;
  return `https://${SHORT_LINK_HOST}${url.pathname}`;
}

/**
 * The canonical URL of the post a short link redirects to: one GET to the link itself, the redirect's
 * Location resolved against it and never fetched; null when the answer is not a redirect to a post.
 * A request that fails or is refused is signal_post_link_unreachable, its egress code as the cause.
 */
export async function resolveShortLink(
  link: string,
  get: Get = shortLinks.get,
): Promise<string | null> {
  let response: FetchSafeResponse;
  try {
    response = await get(link, SHORT_LINK_REQUEST);
  } catch (error) {
    if (!isAppError(error) || !error.code.startsWith("egress_")) throw error;
    throw new AppError(errors.signal_post_link_unreachable, { cause: error });
  }
  const { location } = response.headers;
  if (!REDIRECT_STATUSES.has(response.status) || location === undefined) return null;
  const target = URL.parse(location, response.finalUrl);
  return target === null ? null : canonicalPostUrl(target.href);
}

/** The config field: a LinkedIn post's URL or short link, stored as the post's canonical URL. */
export const postUrl = z
  .string()
  .max(2048)
  .transform(async (value, context) => {
    const given = value.trim();
    const link = shortLinkUrl(given);
    const canonical = link === null ? canonicalPostUrl(given) : await resolveShortLink(link);
    if (canonical !== null) return canonical;
    context.addIssue({ code: "custom", message: "a LinkedIn post URL" });
    return z.NEVER;
  });
