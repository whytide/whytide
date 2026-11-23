// The email writer's scorer's values (score.ts; gamma-p3-075). The phrase lists it reads are the
// LinkedIn writer's scorer's copies (../messaging.write-message/), which tests/evals.test.ts keeps
// equal to messaging's. Plain values; nothing imported.

/**
 * The words a follow-up's body opens with, which no earlier email of its step may have opened with
 * (no_repeat), after the gates' plain(): the greeting and the first words after it. Not in the sources.
 */
export const OPENING_WORDS = 6;

/**
 * A link as messaging's links gate finds one (domain/gates/policies.ts), in short: an http(s)
 * address, `www.`, an email address, or a bare domain, a word, a dot and 2 to 24 letters, so "e.g."
 * and "U.S." are none.
 */
export const LINK_PATTERNS = [
  /\bhttps?:\/\/[^\s<>"]+/iu,
  /\bwww\.[^\s<>"]+/iu,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u,
  /(?<![\p{L}\p{N}.@/-])(?:[\p{L}\p{N}-]+\.)+\p{L}{2,24}(?![\p{L}\p{N}])/u,
] as const;
