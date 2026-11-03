// onboarding's rules without a database (alpha-p4-010; docs/concepts.md): the field-source marking,
// what a save stores, the URL rule and the company's domain. The routes are the api host's test,
// core/apps/api/tests/onboarding-company-knowledge.test.ts. And what an accept writes (alpha-p4-030),
// and a proof point citing a document (knowledge-draft).
import assert from "node:assert/strict";
import test from "node:test";
import { isAppError } from "@whytide/platform";
import type { CompanyKnowledgeFields, FieldSources } from "../domain/fields.ts";
import { applyDraft, changedFields, domainOf, markFields, normalize } from "../domain/rules.ts";
import type { DraftOutput } from "../schemas/draft-company-knowledge.ts";

const empty: CompanyKnowledgeFields = {
  sourceUrl: null,
  oneLiner: "",
  longDescription: "",
  products: [],
  painPoints: [],
  featuresBenefits: [],
  proofPoints: [],
  competitors: [],
  tone: "",
};
const drafted = {
  kind: "ai_draft",
  at: "2026-10-20T10:00:00.000Z",
  sourceUrl: "https://acme.test/",
} as const;
const human = { kind: "human", at: "2026-10-22T09:00:00.000Z" } as const;

test("marking: each changed field becomes human, the others keep their source; a list's order counts, spaces do not", () => {
  const stored = { ...empty, longDescription: "Acme sells robots.", products: ["Arm", "Cart"] };
  const sources: FieldSources = { longDescription: drafted, products: drafted, tone: drafted };
  const next = normalize({
    ...stored,
    oneLiner: " Robots for warehouses ",
    longDescription: "Acme sells robots. ",
    products: ["Cart", "Arm"],
    proofPoints: [
      { text: "40% faster picking" },
      { text: "Beta", sourceUrl: "https://acme.test/" },
    ],
  });
  const changed = changedFields(stored, next);
  assert.deepEqual(changed, ["oneLiner", "products", "proofPoints"]);
  assert.deepEqual(markFields(sources, changed, human), {
    longDescription: drafted,
    products: human,
    tone: drafted,
    oneLiner: human,
    proofPoints: human,
  });
  assert.deepEqual(changedFields(next, normalize(next)), [], "the same save again changes nothing");
});

test("a save stores texts trimmed and items once; a URL that is not http or https is refused by its path", () => {
  const stored = normalize({
    ...empty,
    sourceUrl: " ",
    competitors: [" Beta ", "Beta", "Gamma"],
    proofPoints: [{ text: "Used by Beta", sourceUrl: " " }, { text: "Used by Beta" }],
  });
  assert.deepEqual(
    [stored.sourceUrl, stored.competitors, stored.proofPoints],
    [null, ["Beta", "Gamma"], [{ text: "Used by Beta" }]],
  );
  const pages = [
    { text: "a", sourceUrl: "https://acme.test/" },
    { text: "b", sourceUrl: "javascript:x" },
  ];
  for (const sourceUrl of ["ftp://acme.test", "https://user:secret@acme.test", "acme.test"]) {
    assert.throws(
      () => normalize({ ...empty, sourceUrl, proofPoints: pages }),
      (error: unknown) =>
        isAppError(error) &&
        error.code === "company_knowledge_invalid_url" &&
        JSON.stringify(error.details) === '{"fields":["sourceUrl","proofPoints.1.sourceUrl"]}',
    );
  }
  assert.deepEqual(
    [domainOf("https://www.Acme.test/about"), domainOf("http://acme.test:8080"), domainOf(null)],
    ["acme.test", "acme.test", null],
  );
});

test("a proof point may cite a document, document:<name>, as its page; the website may not, nor a proof point a document source with no name", () => {
  const deck = { text: "Trusted by 300 shops", sourceUrl: " document:deck.pdf " };
  const stored = normalize({ ...empty, proofPoints: [deck] });
  assert.deepEqual(stored.proofPoints, [
    { text: "Trusted by 300 shops", sourceUrl: "document:deck.pdf" },
  ]);
  const bad = ["document:", "document:a/b.pdf", "document:bell\u0007.pdf", "Document:deck.pdf"];
  for (const sourceUrl of bad) {
    assert.throws(
      () =>
        normalize({
          ...empty,
          sourceUrl: "document:deck.pdf",
          proofPoints: [{ text: "a", sourceUrl }],
        }),
      (error: unknown) =>
        isAppError(error) &&
        JSON.stringify(error.details) === '{"fields":["sourceUrl","proofPoints.0.sourceUrl"]}',
      sourceUrl,
    );
  }
});

test("an accept writes each drafted field a person did not edit, marked ai_draft with its page; an edited one only with replaceEdited", () => {
  const [home, about, customers] = ["/", "/about", "/customers"].map(
    (path) => `https://acme.test${path}`,
  ) as [string, string, string];
  const cite = (text: string, sourceUrl = home) => ({ text, sourceUrl, quote: "q" });
  const stored = {
    ...empty,
    sourceUrl: "https://acme.test/",
    oneLiner: "Our own words",
    products: ["Arm"],
    fieldSources: { oneLiner: human, products: drafted } satisfies FieldSources,
  };
  const draft: DraftOutput = {
    oneLiner: cite("Robots for warehouses"),
    longDescription: cite(" Acme builds picking robots. ", about),
    products: [cite("Picking arm"), cite("Picking arm"), cite("Cart", about)],
    painPoints: [],
    featuresBenefits: [cite("   ")],
    proofPoints: [cite("Used by 120 warehouses", customers)],
    competitors: [],
    tone: null,
  };
  const at = "2026-10-22T12:00:00.000Z";
  const mark = (sourceUrl?: string) => ({ kind: "ai_draft", at, sourceUrl }) as const;
  const accepted = applyDraft(stored, draft, { replaceEdited: false, at });
  assert.deepEqual(accepted.changed, ["longDescription", "products", "proofPoints"]);
  assert.deepEqual(accepted.fields, {
    ...empty,
    sourceUrl: "https://acme.test/",
    oneLiner: "Our own words",
    longDescription: "Acme builds picking robots.",
    products: ["Picking arm", "Cart"],
    proofPoints: [{ text: "Used by 120 warehouses", sourceUrl: customers }],
  });
  assert.deepEqual(accepted.fieldSources, {
    oneLiner: human,
    longDescription: mark(about),
    products: mark(home),
    proofPoints: mark(customers),
  });
  const replaced = applyDraft(stored, draft, { replaceEdited: true, at });
  assert.deepEqual(replaced.changed, ["oneLiner", "longDescription", "products", "proofPoints"]);
  assert.deepEqual(
    [replaced.fields.oneLiner, replaced.fieldSources.oneLiner],
    ["Robots for warehouses", mark(home)],
  );
  const again = { ...replaced.fields, fieldSources: replaced.fieldSources };
  const same = applyDraft(again, draft, { replaceEdited: true, at: "2026-10-23T08:00:00.000Z" });
  assert.deepEqual([same.changed, same.fieldSources], [[], replaced.fieldSources]);
});
