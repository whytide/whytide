// A response schema as OpenAI's strict mode takes it (README.md "Known differences"): with strict
// on, a keyword outside the subset strict mode supports fails the call, so the adapter's model
// sends a copy that keeps only STRICT_KEYWORDS, and `format` only as one of STRICT_FORMATS, at
// every level. The caller's schema is left as it is, and zod still checks every answer against all
// of it.
import type { JSONSchema7 } from "@ai-sdk/provider";
import { STRICT_FORMATS, STRICT_KEYWORDS } from "./constants.ts";

/** The keywords whose value is a schema or a list of them, and those holding schemas by name. */
const SUBSCHEMAS = new Set(["items", "additionalProperties", "anyOf"]);
const BY_NAME = new Set(["properties", "$defs", "definitions"]);

/** A copy of `schema` in strict mode's subset. */
export function strictSubset(schema: JSONSchema7): JSONSchema7 {
  return subset(schema) as JSONSchema7;
}

/** A schema, a list of schemas or `true`/`false`, copied with only the supported keywords. */
function subset(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(subset);
  if (typeof node !== "object" || node === null) return node;
  const kept: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (!STRICT_KEYWORDS.has(keyword)) continue;
    if (keyword === "format" && !STRICT_FORMATS.has(String(value))) continue;
    kept[keyword] = SUBSCHEMAS.has(keyword)
      ? subset(value)
      : BY_NAME.has(keyword) && typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, subset(inner)]))
        : structuredClone(value);
  }
  return kept;
}
