// The drafter's gates without a model (alpha-p4-030; docs/security.md "The drafter"), a document's
// source checked like a page's (knowledge-draft), and the input's bound on a text, all that a page or
// a document keeps (draft-full-text). The runs are the worker's test,
// core/apps/worker/tests/onboarding-draft.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { DOCUMENT_LIMITS } from "../domain/constants.ts";
import {
  DRAFT_GATES,
  limitsGate,
  normalizeQuote,
  quotesGate,
  sourcesGate,
} from "../domain/draft-gates.ts";
import {
  type DraftInput,
  type DraftOutput,
  draftInput,
} from "../schemas/draft-company-knowledge.ts";
import { FETCH_LIMITS } from "../workflows/fetch-website.ts";

const HOME = "https://acme.test/";
const ABOUT = "https://acme.test/about";
const input: DraftInput = {
  pages: [
    { url: HOME, title: "Acme", text: "# Robots for warehouses\nAcme builds   picking robots." },
    { url: ABOUT, title: "About", text: "Founded in 2019.\n<Trusted> by 120 warehouses." },
  ],
};
const none: DraftOutput = {
  ...{ oneLiner: null, longDescription: null, tone: null },
  ...{ products: [], painPoints: [], featuresBenefits: [], proofPoints: [], competitors: [] },
};
const cite = (text: string, sourceUrl: string, quote: string) => ({ text, sourceUrl, quote });
const valid: DraftOutput = {
  ...none,
  oneLiner: cite("Acme builds picking robots.", HOME, "ACME builds picking\nrobots"),
  products: [cite("Picking robots", HOME, "picking robots.")],
  proofPoints: [cite("Trusted by 120 warehouses", ABOUT, "&lt;trusted> by 120 warehouses")],
};

test("a draft citing pages read and quoting them passes every gate, case, whitespace and &lt; aside; so does one with no value", () => {
  for (const output of [valid, none]) {
    assert.deepEqual(
      DRAFT_GATES.map((gate) => gate(output, input).issues),
      [[], [], []],
    );
  }
  assert.equal(normalizeQuote("  A\n\tB  &lt;C> "), "a b <c>");
});

test("sources: a value citing a page that was not read is an issue at its sourceUrl", () => {
  const output = {
    ...valid,
    tone: cite("Plain", "https://elsewhere.test/", "plain"),
    products: [...valid.products, cite("Carts", `${HOME}carts`, "picking robots")],
  };
  assert.deepEqual(sourcesGate(output, input), {
    gate: "sources",
    issues: [
      { path: "tone.sourceUrl", message: "not the url of a page read" },
      { path: "products.1.sourceUrl", message: "not the url of a page read" },
    ],
  });
});

test("quotes: a quote of another page, or of words no page has, or an empty one, is an issue; a page not read is left to the sources gate", () => {
  const output = {
    ...valid,
    longDescription: cite("Founded in 2019.", HOME, "Founded in 2019"),
    painPoints: [cite("Slow picking", HOME, "  ")],
    competitors: [cite("Beta Robotics", ABOUT, "Beta Robotics is slower")],
    tone: cite("Plain", "https://elsewhere.test/", "nothing of it"),
  };
  assert.deepEqual(quotesGate(output, input), {
    gate: "quotes",
    issues: [
      { path: "longDescription.quote", message: "not in the text of its page" },
      { path: "painPoints.0.quote", message: "empty" },
      { path: "competitors.0.quote", message: "not in the text of its page" },
    ],
  });
});

test("a document is read like a page: a value citing document:<name> and quoting its text passes; one citing a document not given, or misquoting one, does not", () => {
  const DECK = "document:deck.pdf";
  const withDocument: DraftInput = {
    pages: [
      ...input.pages,
      { url: DECK, title: "deck.pdf", text: "Corvid Freight\nTrusted by 300 shops." },
    ],
  };
  const output = {
    ...valid,
    proofPoints: [cite("Trusted by 300 shops", DECK, "trusted by 300  shops")],
  };
  assert.deepEqual(
    DRAFT_GATES.map((gate) => gate(output, withDocument).issues),
    [[], [], []],
  );
  const wrong = {
    ...output,
    competitors: [cite("Wren Parcels", "document:other.pdf", "Corvid Freight")],
    tone: cite("Plain", DECK, "Founded in 2019"),
  };
  assert.deepEqual(sourcesGate(wrong, withDocument).issues, [
    { path: "competitors.0.sourceUrl", message: "not the url of a page read" },
  ]);
  assert.deepEqual(quotesGate(wrong, withDocument).issues, [
    { path: "tone.quote", message: "not in the text of its page" },
  ]);
});

test("limits: a list past twenty items, a text past its field's length, an item past an item's or a proof point's", () => {
  const products = Array.from({ length: 21 }, (_, at) => cite(`Robot ${at}`, HOME, "robots"));
  const output = {
    ...valid,
    oneLiner: cite("a".repeat(201), HOME, "acme"),
    products,
    proofPoints: [cite("b".repeat(501), ABOUT, "founded")],
    competitors: [cite("c".repeat(201), HOME, "acme")],
  };
  assert.deepEqual(limitsGate(output), {
    gate: "limits",
    issues: [
      { path: "products", message: "more than 20 items" },
      { path: "oneLiner.text", message: "longer than 200 characters" },
      { path: "proofPoints.0.text", message: "longer than 500 characters" },
      { path: "competitors.0.text", message: "longer than 200 characters" },
    ],
  });
  const atLimit = { ...valid, oneLiner: cite(` ${"a".repeat(200)} `, HOME, "acme") };
  assert.deepEqual(limitsGate(atLimit).issues, []);
});

test("the drafter's input takes a page's and a document's text whole, as much as the fetch and the documents keep; a character more is refused", () => {
  assert.equal(DOCUMENT_LIMITS.text, FETCH_LIMITS.text);
  const page = (text: string) => ({ pages: [{ url: HOME, title: "Acme", text }] });
  const full = "x".repeat(FETCH_LIMITS.text);
  assert.deepEqual(draftInput.parse(page(full)), page(full));
  const over = draftInput.safeParse(page(`${full}x`));
  assert.deepEqual(
    over.error?.issues.map((issue) => issue.path.join(".")),
    ["pages.0.text"],
  );
});
