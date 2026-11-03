// The dossier's hash (README.md "The dossier"): the SHA-256 of its canonical JSON, every object's keys
// sorted at every depth, so that the same dossier gives the same hash whatever order it was built in.
// A draft keeps it (alpha-p9-020), so that a changed fact is visible.
import { createHash } from "node:crypto";

/** JSON without whitespace, every object's keys sorted by code unit; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The hex SHA-256 of the value's canonical JSON. */
export function hashOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
