// Provenance per field (docs/rules/coding.md §5; data model §2.5, reduced to the source class, the
// provider and the time): every value of a person or a company records where it came from and when,
// under its field's name in field_provenance. A source's values merge field by field.
export const SOURCES = ["linkedin", "import", "website"] as const;
export const PROVIDERS = ["unipile", "csv"] as const;
export type Source = (typeof SOURCES)[number];
export type Provider = (typeof PROVIDERS)[number] | null;
export type Provenance = {
  readonly source: Source;
  readonly provider: Provider;
  readonly at: string;
};
export type ProvenanceMap = Readonly<Record<string, Provenance>>;
type Values = Readonly<Record<string, unknown>>;

/**
 * The fields to write and the provenance to keep once a source's `incoming` values, stamped `stamp`,
 * meet the stored record. A field the source brings with a value takes it and the stamp, unless the
 * stored value was fetched later; a field it does not bring, or brings empty, keeps both.
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
