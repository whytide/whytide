// The processing's rules (README.md "Processing"), plain functions: who is the workspace's own staff,
// an engagement's dedupe key, and the excerpt of a person's own words.
import { createHash } from "node:crypto";

/** The excerpt's length, in characters (RB-4.4.3). */
export const EXCERPT_LENGTH = 500;
/** A whole word: no letter or digit touches the match on either side. */
const EDGE = "[\\p{L}\\p{N}]";

/**
 * Whether a text, a headline, a company or its page, names the workspace's own company: its domain
 * or its name, as whole words in any case (decisions.md, 2026-10-22). A term under two characters
 * matches nothing.
 */
export function ownCompanyRule(own: {
  readonly domain: string | null;
  readonly name: string | null;
}): (text: string | null | undefined) => boolean {
  const terms = [own.domain, own.name]
    .map((term) => term?.trim() ?? "")
    .filter((term) => [...term].length >= 2);
  if (terms.length === 0) return () => false;
  const words = terms.map((term) => term.split(/\s+/).map(escaped).join("\\s+"));
  const pattern = new RegExp(`(?<!${EDGE})(?:${words.join("|")})(?!${EDGE})`, "iu");
  return (text) => typeof text === "string" && pattern.test(text);
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The key that makes one event of an engagement: the event's kind, its subject (the engager, by the
 * provider's member reference, which the run has before any read), its object (the post) and the
 * actor's role (the reaction), hashed, so the same engagement seen twice is one event.
 */
export function dedupeKeyOf(event: {
  readonly kind: string;
  readonly actor: string;
  readonly objectUrl: string;
  readonly role: string;
}): string {
  const parts = [event.kind, event.actor, event.objectUrl, event.role];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** The first 500 characters of the person's own words, never half a character; null without any. */
export function excerptOf(words: string | null | undefined): string | null {
  const text = words?.trim() ?? "";
  return text === "" ? null : Array.from(text).slice(0, EXCERPT_LENGTH).join("");
}
