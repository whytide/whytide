// The budget estimator (README.md "The budget"): the input tokens of a call, counted before any model
// is asked for.

/**
 * An upper estimate of a text's tokens: its UTF-8 bytes over three, rounded up. It is never below the
 * LLM fake's count, UTF-16 code units over four, since a code unit takes at least one byte; real
 * tokenizers average three to four characters a token on English prose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}
