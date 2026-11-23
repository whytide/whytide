// Provenance per field (docs/rules/coding.md §5; data model §2.5, reduced to the source class, the
// provider and the time): every value of a person or a company records where it came from and when,
// under its field's name in field_provenance. A source's values merge field by field; a member's
// value (lead-fields-edit) outranks every source's. The class is what the page shows (RB-7.3.2); the
// provider, an adapter's or a source's name, is never shown.
/**
 * The source classes a person's or a company's values are fetched from: LinkedIn, an import, the
 * website, and enrichment's (gamma-en-040): open data, a data vendor, a web search, the AI's inference.
 */
export const SOURCES = [
  "linkedin",
  "import",
  "website",
  "open_data",
  "data_vendor",
  "web_search",
  "ai_inferred",
] as const;
/** A member's own value, typed on the lead page (person-edit.ts): never a source's input. */
export const MEMBER = "member";
/** Every source class a field's provenance names: the sources' and the member's. */
export const PROVENANCE_SOURCES = [...SOURCES, MEMBER] as const;
/**
 * A provider's name: an adapter's or a source's, as providers' ADAPTER_NAME takes it
 * (core/packages/providers/_pattern/config.ts), such as `unipile`, `csv` or `wikidata`; a new source
 * needs no change here. Copied, as contacts does not depend on providers; tests/provenance.test.ts
 * keeps the two equal.
 */
export const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/;
/** A provider's name at most, in characters. */
export const PROVIDER_NAME_MAX = 64;
export type Source = (typeof SOURCES)[number];
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];
/** A provider's name (PROVIDER_NAME), or null for none, such as a member's value. */
export type Provider = string | null;
export type Provenance = {
  readonly source: ProvenanceSource;
  readonly provider: Provider;
  readonly at: string;
};
export type ProvenanceMap = Readonly<Record<string, Provenance>>;
type Values = Readonly<Record<string, unknown>>;

/**
 * The fields to write and the provenance to keep once a source's `incoming` values, stamped `stamp`,
 * meet the stored record. A field the source brings with a value takes it and the stamp, unless the
 * stored value was fetched later or a member set it (a member's stamp only gives way to a member's);
 * a field it does not bring, or brings empty, keeps both.
 */
export function mergeFields(
  provenance: ProvenanceMap,
  incoming: Values,
  stamp: Provenance,
): { values: Record<string, unknown>; provenance: Record<string, Provenance> } {
  const values: Record<string, unknown> = {};
  const merged: Record<string, Provenance> = { ...provenance };
  for (const [field, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || value === "") continue;
    const stored = merged[field];
    if (stored !== undefined && Date.parse(stored.at) > Date.parse(stamp.at)) continue;
    if (stored?.source === MEMBER && stamp.source !== MEMBER) continue;
    values[field] = value;
    merged[field] = stamp;
  }
  return { values, provenance: merged };
}

/** A full name as a first and a last name: the first word, then the rest ("Maria de la Cruz"). */
export function splitName(name: string | undefined): { firstName?: string; lastName?: string } {
  const [first, ...rest] = (name ?? "").trim().split(/\s+/);
  return { firstName: first || undefined, lastName: rest.join(" ") || undefined };
}
