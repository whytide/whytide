// The dossier (README.md "The dossier", docs/concepts.md): the shape buildDossier answers and the
// route documents. Every object is strict, so no field but these can be present: no email, phone,
// photo or other contact detail, nothing a visibility setting hides (tests/schema.test.ts).
import { z } from "zod";

/** The kinds of the entities a draft's are matched against: every fact kind but the free texts. */
export const ENTITY_KINDS = [
  "name",
  "company",
  "title",
  "number",
  "tool",
  "event",
  "date",
] as const;
/** What a fact is. Only a proof point is a `claim`: the only claims a draft may cite. */
export const FACT_KINDS = [...ENTITY_KINDS, "claim", "quote"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export type EntityKind = (typeof ENTITY_KINDS)[number];

const value = z.string().min(1);

export const factSchema = z.strictObject({
  /** `f_1`, `f_2`, … in the dossier's canonical order. */
  id: z.string().regex(/^f_[1-9][0-9]*$/),
  kind: z.enum(FACT_KINDS),
  value,
  /** The record and field the value came from: `<table>/<id>/<column>`, then an item's index. */
  sourceRef: value,
});
export type Fact = z.infer<typeof factSchema>;

export const dossierSchema = z.strictObject({
  /** The signed-in user who will send the message. */
  sender: z.strictObject({ name: value.nullable() }),
  /** Company Knowledge: its proof points are the only citable claims. */
  offer: z.strictObject({
    oneLiner: value.nullable(),
    products: z.array(value),
    painPoints: z.array(value),
    proofPoints: z.array(value),
  }),
  /** The person's stored business fields. */
  lead: z.strictObject({
    firstName: value.nullable(),
    headline: value.nullable(),
    title: value.nullable(),
    location: value.nullable(),
  }),
  company: z.strictObject({
    name: value.nullable(),
    industry: value.nullable(),
    sizeRange: value.nullable(),
    /** The country's English name. */
    country: value.nullable(),
  }),
  /** The person's signal events with their evidence, newest first. */
  whyNow: z.array(
    z.strictObject({
      postUrl: value,
      /** Null for a reaction, and once the evidence is reduced (alpha-p10-020). */
      excerpt: value.nullable(),
      comment: value.nullable(),
      reaction: value,
      at: z.iso.datetime(),
    }),
  ),
  /** Every value of the blocks above, once each. */
  facts: z.array(factSchema),
  /** What the grounding gate matches a draft's entities against (domain/dossier/entities.ts). */
  entities: z.array(
    z.strictObject({
      kind: z.enum(ENTITY_KINDS),
      value,
      factIds: z.array(z.string()),
    }),
  ),
  /** SHA-256, in hex, of the canonical JSON of everything above. */
  dossierHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Dossier = z.infer<typeof dossierSchema>;
export type Entity = Dossier["entities"][number];

export const dossierParams = z.strictObject({ personId: z.string().min(1).max(64) });
