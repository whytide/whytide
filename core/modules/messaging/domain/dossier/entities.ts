// The dossier's entities (README.md "The dossier", docs/concepts.md): what the grounding gate
// (alpha-p9-020) matches a draft's names, companies, numbers, tools, events and dates against. The
// claims and quotes are free texts the gate searches itself, so they give none.
import type { Entity, EntityKind, Fact } from "../../schemas/dossier.ts";
import { ENTITY_KINDS } from "../../schemas/dossier.ts";

/** A value as the gate compares it: compatibility form, no accents, lower case, single spaces. */
export function normalizeEntity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

const isEntityKind = (kind: Fact["kind"]): kind is EntityKind =>
  (ENTITY_KINDS as readonly string[]).includes(kind);

/**
 * One entity per kind and normalized value, with the ids of the facts it comes from, in the kinds'
 * order and then by value; a date is its UTC day (`2026-10-02`).
 */
export function entitiesOf(facts: readonly Fact[]): Entity[] {
  const found = new Map<string, Entity>();
  for (const { id, kind, value } of facts) {
    if (!isEntityKind(kind)) continue;
    const normalized = kind === "date" ? value.slice(0, 10) : normalizeEntity(value);
    if (normalized === "") continue;
    const key = `${kind}\u0000${normalized}`;
    const entity = found.get(key) ?? { kind, value: normalized, factIds: [] };
    entity.factIds.push(id);
    found.set(key, entity);
  }
  const rank = (kind: EntityKind) => ENTITY_KINDS.indexOf(kind);
  return [...found.values()].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  );
}
