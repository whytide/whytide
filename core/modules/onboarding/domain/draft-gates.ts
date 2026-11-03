// The drafter's gates, in code (docs/security.md "The drafter"; security §6, briefs §25): each reads
// a valid output with the input the model read and returns issues, never throws and never changes the
// output; callAgent retries a failed gate once, the issues in <validation_error>, then answers
// ai_failed. An issue names a path and the rule broken, never a page's words. Pure.
import type { GateResult } from "@whytide/ai";
import type { Cited, DraftInput, DraftOutput } from "../schemas/draft-company-knowledge.ts";
import { LIMITS } from "./fields.ts";

/** The text fields with their limits; the lists with an item's. */
const TEXTS = {
  oneLiner: LIMITS.oneLiner,
  longDescription: LIMITS.longDescription,
  tone: LIMITS.tone,
} as const;
const LISTS = {
  products: LIMITS.item,
  painPoints: LIMITS.item,
  featuresBenefits: LIMITS.item,
  proofPoints: LIMITS.proofPoint,
  competitors: LIMITS.item,
} as const;

type Item = Cited & { readonly path: string; readonly max: number };

/** Every drafted value with its path (`oneLiner`, `products.2`) and the limit of its text. */
function items(output: DraftOutput): Item[] {
  const texts = Object.entries(TEXTS).flatMap(([field, max]) => {
    const item = output[field as keyof typeof TEXTS];
    return item === null ? [] : [{ ...item, path: field, max }];
  });
  const lists = Object.entries(LISTS).flatMap(([field, max]) =>
    output[field as keyof typeof LISTS].map((item, at) => ({
      ...item,
      path: `${field}.${at}`,
      max,
    })),
  );
  return [...texts, ...lists];
}

/** Lower case, each run of whitespace one space; `&lt;` read as `<`, since the blocks write `<` so. */
export function normalizeQuote(text: string): string {
  return text.replaceAll("&lt;", "<").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Every value's `sourceUrl` is the `url` of a page the model read. */
export function sourcesGate(output: DraftOutput, input: DraftInput): GateResult {
  const urls = new Set(input.pages.map((page) => page.url));
  const issues = items(output)
    .filter((item) => !urls.has(item.sourceUrl))
    .map((item) => ({ path: `${item.path}.sourceUrl`, message: "not the url of a page read" }));
  return { gate: "sources", issues };
}

/** Every value's quote, whitespace and case aside, is words of its page's text; never empty. */
export function quotesGate(output: DraftOutput, input: DraftInput): GateResult {
  const texts = new Map(input.pages.map((page) => [page.url, normalizeQuote(page.text)]));
  const issues = items(output).flatMap((item) => {
    const text = texts.get(item.sourceUrl);
    const quote = normalizeQuote(item.quote);
    // A page that was not read is the sources gate's issue.
    if (text === undefined || (quote !== "" && text.includes(quote))) return [];
    const message = quote === "" ? "empty" : "not in the text of its page";
    return [{ path: `${item.path}.quote`, message }];
  });
  return { gate: "quotes", issues };
}

/** Every list within the record's count of items, every value within its field's length. */
export function limitsGate(output: DraftOutput): GateResult {
  const counts = Object.keys(LISTS)
    .filter((field) => output[field as keyof typeof LISTS].length > LIMITS.items)
    .map((field) => ({ path: field, message: `more than ${LIMITS.items} items` }));
  const lengths = items(output)
    .filter((item) => item.text.trim().length > item.max)
    .map((item) => ({ path: `${item.path}.text`, message: `longer than ${item.max} characters` }));
  return { gate: "limits", issues: [...counts, ...lengths] };
}

export const DRAFT_GATES = [sourcesGate, quotesGate, limitsGate];
