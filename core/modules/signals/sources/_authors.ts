// The author pages the competitor and creator kinds read (README.md "Kinds"; gamma-p5-025): a
// company's page, /company/<id>, and a member's profile, /in/<id>, by providers' AUTHOR_PATHS, which
// linkedin's listAuthorPosts takes; https on linkedin.com, with or without www. Stored as
// https://www.linkedin.com/<company|in>/<id>, without the query, the fragment or a trailing slash, as
// post_engagers stores a post (post-url.ts). The erasure's match on a profile compares its id
// decoded and in lower case, as the person's public id (README.md "Reduction").
import { AUTHOR_PATHS } from "@whytide/providers";
import { z } from "zod";
import { decodedLower } from "./_posts.ts";
import { AUTHOR_PREFIXES, LINK_MAX_CHARS, LINKEDIN_HOSTS, LINKEDIN_ORIGIN } from "./constants.ts";

/** An author's page: a member's profile or a company's page. */
export type AuthorPage = keyof typeof AUTHOR_PATHS;

/** The page's link as signals stores it, or null when `value` is no LinkedIn page of the kind. */
export function canonicalAuthorUrl(value: string, page: AuthorPage): string | null {
  const url = URL.parse(value.trim());
  if (url === null || url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  if (!LINKEDIN_HOSTS.has(url.hostname)) return null;
  const id = AUTHOR_PATHS[page].exec(url.pathname)?.[1];
  return id === undefined ? null : `${LINKEDIN_ORIGIN}${AUTHOR_PREFIXES[page]}${id}`;
}

/** A config field: the link of a page of the kind, stored canonical; any other link is invalid. */
export const authorUrl = (page: AuthorPage) =>
  z
    .string()
    .max(LINK_MAX_CHARS)
    .transform((value, context) => {
      const canonical = canonicalAuthorUrl(value, page);
      if (canonical !== null) return canonical;
      context.addIssue({ code: "custom", message: `a LinkedIn ${page} page's link` });
      return z.NEVER;
    });

/** The profile's link names the person whose public id is `slug`, decoded and in lower case. */
export function namesMember(profileUrl: string, slug: string): boolean {
  const id = AUTHOR_PATHS.member.exec(URL.parse(profileUrl)?.pathname ?? "")?.[1];
  return slug !== "" && id !== undefined && decodedLower(id) === slug;
}
