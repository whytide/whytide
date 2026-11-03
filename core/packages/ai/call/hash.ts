// The input hash of the result cache (README.md "Calling an agent"): sha256 of the parsed input as
// canonical JSON, so that one input gives one hash whatever the order of its keys.
import { createHash } from "node:crypto";

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with the keys of every object sorted, at any depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(byKey))
      : item,
  );
}

/** The hex sha256 of the input's canonical JSON. */
export function inputHash(input: object): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}
