// The two layers above a workspace's company (gamma-rf-010; docs/concepts.md "Companies"), pure: the
// shared company, which every organization reads, and the sharing group's row, which only the
// group's workspaces read. A read takes each fact from the layer whose stamp wins; a write or a link
// places each value on one layer by its stamp's class (sharing.ts) and merges it there as
// mergeFields merges a person's fields. The keys and the name stay on the workspace's row, which
// suppression reads; a layer's keys only find the company and fill a row that lacks one.
import { MEMBER, mergeFields, type Provenance, type ProvenanceMap } from "../provenance.ts";
import {
  COMPANY_FACTS,
  COMPANY_KEYS,
  type CompanyFact,
  type CompanyKey,
  ONE_PERSON,
  PROVIDER_REFS,
  SIZE_BOUNDS,
} from "./constants.ts";

type Refs = Readonly<Record<string, string>>;

/** A layer's row: the shared company's or the group's keys, facts and vendors' ids, with stamps. */
export type Layer = {
  readonly linkedinUrl: string | null;
  readonly domain: string | null;
  readonly industry: string | null;
  readonly sizeRange: string | null;
  readonly country: string | null;
  readonly employeeCount: number | null;
  readonly description: string | null;
  readonly providerRefs: Refs | null;
  readonly fieldProvenance: ProvenanceMap;
};
export type LayerField = CompanyFact | CompanyKey | typeof PROVIDER_REFS;

/** One value to place on a layer, with its stamp; none for an old row's value that has no stamp. */
export type Placed = {
  readonly field: LayerField;
  readonly value: string | number | Refs;
  readonly stamp: Provenance | undefined;
};

/** What a read takes from the layers: the facts and the vendors' ids, with the stamps that won. */
export type LayeredFacts = {
  readonly values: Pick<Layer, CompanyFact | typeof PROVIDER_REFS>;
  readonly provenance: Record<string, Provenance>;
};

type Candidate = { readonly value: unknown; readonly stamp: Provenance | undefined };

export const isKey = (field: LayerField): field is CompanyKey =>
  (COMPANY_KEYS as readonly string[]).includes(field);

/**
 * The candidate that wins: a member's value first, as mergeFields keeps it; then the one with a
 * stamp over one without; then the newer stamp; on a tie, the group's, the closer to the customer.
 */
function winner(shared?: Candidate, group?: Candidate): Candidate | undefined {
  if (shared === undefined || group === undefined) return shared ?? group;
  if (group.stamp?.source === MEMBER) return group;
  if (shared.stamp?.source === MEMBER) return shared;
  if (shared.stamp === undefined || group.stamp === undefined) {
    return group.stamp === undefined && shared.stamp !== undefined ? shared : group;
  }
  return Date.parse(shared.stamp.at) > Date.parse(group.stamp.at) ? shared : group;
}

function candidate(layer: Layer | null, field: LayerField): Candidate | undefined {
  const value = layer?.[field];
  if (layer === null || value === null || value === undefined) return undefined;
  return { value, stamp: layer.fieldProvenance[field] };
}

/**
 * The facts a linked row reads: each the shared company's or the group's, the one whose stamp wins
 * (winner), with that stamp; the vendors' ids merged, the group's first, so it keeps a provider's
 * id where both name one.
 */
export function readLayers(shared: Layer | null, group: Layer | null): LayeredFacts {
  const values: Record<string, unknown> = {};
  const provenance: Record<string, Provenance> = {};
  for (const field of COMPANY_FACTS) {
    const won = winner(candidate(shared, field), candidate(group, field));
    values[field] = won?.value ?? null;
    if (won?.stamp !== undefined) provenance[field] = won.stamp;
  }
  const refs = { ...group?.providerRefs };
  for (const [provider, id] of Object.entries(shared?.providerRefs ?? {})) refs[provider] ??= id;
  values[PROVIDER_REFS] = Object.keys(refs).length === 0 ? null : refs;
  const refsStamp = winner(
    candidate(shared, PROVIDER_REFS),
    candidate(group, PROVIDER_REFS),
  )?.stamp;
  if (refsStamp !== undefined) provenance[PROVIDER_REFS] = refsStamp;
  return { values: values as LayeredFacts["values"], provenance };
}

/** The upper bound of a size as text (SIZE_BOUNDS): `0-1` is 1, `1-10` is 10; none for `10,001+`. */
export function sizeUpperBound(size: string | null | undefined): number | null {
  const bounds = SIZE_BOUNDS.exec(size ?? "");
  if (bounds === null || bounds[3] !== undefined) return null;
  return Number((bounds[2] ?? bounds[1] ?? "").replaceAll(",", ""));
}

/**
 * Whether a headcount or a size reads as a one-person company: a count of 1, or a size whose upper
 * bound is 1. Its facts describe a person, so they stay with the group, whatever their class.
 */
export function readsOnePerson(facts: {
  readonly employeeCount?: number | null;
  readonly sizeRange?: string | null;
}): boolean {
  return facts.employeeCount === ONE_PERSON || sizeUpperBound(facts.sizeRange) === ONE_PERSON;
}

/**
 * The values to write on a layer and its provenance once `placed` merge into it, each with its own
 * stamp as mergeFields merges one: a newer stamp takes the field, a member's is never replaced by a
 * source's. A value without a stamp, an old row's, only fills a field the layer has empty. The
 * vendors' ids join the layer's, the incoming id kept where both name a provider.
 */
export function mergeInto(
  layer: Layer,
  placed: readonly Placed[],
): { values: Record<string, unknown>; provenance: Record<string, Provenance> } {
  const values: Record<string, unknown> = {};
  let provenance: Record<string, Provenance> = { ...layer.fieldProvenance };
  for (const { field, stamp, ...item } of placed) {
    const value =
      field === PROVIDER_REFS
        ? { ...(values[field] ?? layer.providerRefs), ...(item.value as Refs) }
        : item.value;
    if (stamp === undefined) {
      if (layer[field] === null && values[field] === undefined) values[field] = value;
      continue;
    }
    const merged = mergeFields(provenance, { [field]: value }, stamp);
    Object.assign(values, merged.values);
    provenance = merged.provenance;
  }
  return { values, provenance };
}

/** A layer with no value: the group's row before its first write. */
export const EMPTY_LAYER: Layer = {
  linkedinUrl: null,
  domain: null,
  industry: null,
  sizeRange: null,
  country: null,
  employeeCount: null,
  description: null,
  providerRefs: null,
  fieldProvenance: {},
};
