// The dossier's assembly (domain/dossier/, README.md "The dossier") on the fixture's reads: the facts
// with their ids, kinds and sources, the entities, the why-now order, the hash and the time it takes.
// The route end to end is the api host's test, core/apps/api/tests/messaging-dossier.test.ts.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { assembleDossier } from "../domain/dossier/assemble.ts";
import { canonicalJson, hashOf } from "../domain/dossier/hash.ts";
import { type Dossier, dossierSchema } from "../schemas/dossier.ts";
import { inputs } from "./fixtures/dossier/inputs.ts";

const [older, newer] = inputs.events.map(({ evidence }) => evidence?.url);
const ck = "company_knowledge/ck_01FIXTURE";
const per = "persons/per_01FIXTURE";
const wco = "workspace_companies/wco_01FIXTURE";

/** Every value of the five blocks, in their order: what facts[] lists, once each. */
function blockValues({ sender, offer, lead, company, whyNow }: Dossier): string[] {
  const values = (node: unknown): string[] =>
    typeof node === "string"
      ? [node]
      : node === null
        ? []
        : Object.values(node as object).flatMap(values);
  return values([sender, offer, lead, company, whyNow]);
}

test("the fixture's dossier has the five blocks, every value once in facts[] with an id and a source, proof points the only claims, why now newest first", () => {
  const dossier = assembleDossier(inputs);
  const { sender, offer, lead, company, whyNow, facts } = dossier;
  assert.deepEqual(
    { sender, offer, lead, company },
    {
      sender: { name: "Sam Writer" },
      offer: {
        oneLiner: "Warm B2B leads from buying signals.",
        products: ["Signal Radar", "Lead Review"],
        painPoints: ["Leads go cold before sales calls them."],
        proofPoints: [
          "Northwind booked 40% more meetings in a quarter.",
          "Used by 120 sales teams.",
        ],
      },
      lead: {
        firstName: "Ines",
        headline: "Head of Data",
        title: "Head of Data",
        location: "Lisbon, Portugal",
      },
      company: {
        name: "Acme",
        industry: "Software Development",
        sizeRange: "51-200",
        country: "Portugal",
      },
    },
  );
  const comment = "Exactly our problem. We lose leads every week.";
  assert.deepEqual(whyNow, [
    {
      postUrl: newer,
      excerpt: "Exactly our problem.",
      comment,
      reaction: "comment",
      at: "2026-10-02T09:00:00.000Z",
    },
    {
      postUrl: older,
      excerpt: null,
      comment: null,
      reaction: "like",
      at: "2026-10-01T09:00:00.000Z",
    },
  ]);
  const expected = [
    ["name", "Sam Writer", "users/usr_01SENDER/display_name"],
    ["quote", "Warm B2B leads from buying signals.", `${ck}/one_liner`],
    ["tool", "Signal Radar", `${ck}/products/0`],
    ["tool", "Lead Review", `${ck}/products/1`],
    ["quote", "Leads go cold before sales calls them.", `${ck}/pain_points/0`],
    ["claim", "Northwind booked 40% more meetings in a quarter.", `${ck}/proof_points/0/text`],
    ["claim", "Used by 120 sales teams.", `${ck}/proof_points/1/text`],
    ["name", "Ines", `${per}/first_name`],
    ["title", "Head of Data", `${per}/headline`],
    ["title", "Head of Data", `${per}/title`],
    ["name", "Lisbon, Portugal", `${per}/location_text`],
    ["company", "Acme", `${wco}/name`],
    ["company", "Software Development", `${wco}/industry`],
    ["number", "51-200", `${wco}/size_range`],
    ["name", "Portugal", `${wco}/country`],
    ["event", newer, "evidence/evd_02NEWER/url"],
    ["quote", "Exactly our problem.", "evidence/evd_02NEWER/excerpt"],
    ["quote", comment, "evidence/evd_02NEWER/comment_text"],
    ["event", "comment", "evidence/evd_02NEWER/reaction"],
    ["date", "2026-10-02T09:00:00.000Z", "signal_events/sev_02NEWER/occurred_at"],
    ["event", older, "evidence/evd_01OLDER/url"],
    ["event", "like", "evidence/evd_01OLDER/reaction"],
    ["date", "2026-10-01T09:00:00.000Z", "signal_events/sev_01OLDER/occurred_at"],
  ];
  const ids = expected.map((_, index) => `f_${index + 1}`);
  assert.deepEqual(
    facts,
    expected.map(([kind, value, sourceRef], index) => ({ id: ids[index], kind, value, sourceRef })),
  );
  assert.deepEqual(
    facts.map(({ value }) => value),
    blockValues(dossier),
  );
  assert.deepEqual(
    facts.filter(({ kind }) => kind === "claim").map(({ value }) => value),
    offer.proofPoints,
  );
  assert.deepEqual(dossier.entities, [
    { kind: "name", value: "ines", factIds: ["f_8"] },
    { kind: "name", value: "lisbon, portugal", factIds: ["f_11"] },
    { kind: "name", value: "portugal", factIds: ["f_15"] },
    { kind: "name", value: "sam writer", factIds: ["f_1"] },
    { kind: "company", value: "acme", factIds: ["f_12"] },
    { kind: "company", value: "software development", factIds: ["f_13"] },
    { kind: "title", value: "head of data", factIds: ["f_9", "f_10"] },
    { kind: "number", value: "51-200", factIds: ["f_14"] },
    { kind: "tool", value: "lead review", factIds: ["f_4"] },
    { kind: "tool", value: "signal radar", factIds: ["f_3"] },
    { kind: "event", value: "comment", factIds: ["f_19"] },
    { kind: "event", value: older, factIds: ["f_21"] },
    { kind: "event", value: newer, factIds: ["f_16"] },
    { kind: "event", value: "like", factIds: ["f_22"] },
    { kind: "date", value: "2026-10-01", factIds: ["f_23"] },
    { kind: "date", value: "2026-10-02", factIds: ["f_20"] },
  ]);
});

test("a research event (gamma-wr-060), whose evidence has no reaction, is no why-now item: the page it names has nothing to cite, and the rest of the dossier is as before", () => {
  const [first] = inputs.events;
  assert.ok(first?.evidence);
  const research = {
    ...first,
    id: "sev_01RESEARCH",
    evidence: { ...first.evidence, id: "evd_01RESEARCH", reaction: null, excerpt: null },
  };
  const dossier = assembleDossier({ ...inputs, events: [research, ...inputs.events] });
  assert.deepEqual(dossier, assembleDossier(inputs));
});

test("the same inputs give the same ids and hash; a changed proof point changes the hash", () => {
  const dossier = assembleDossier(inputs);
  assert.match(dossier.dossierHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(assembleDossier(structuredClone(inputs)), dossier);
  const reordered = { ...inputs, events: [...inputs.events].reverse() };
  assert.equal(assembleDossier(reordered).dossierHash, dossier.dossierHash);
  const proofPoints = [
    { text: "Northwind booked 45% more meetings in a quarter." },
    { text: "Used by 120 sales teams." },
  ];
  const knowledge = { ...inputs.knowledge, proofPoints };
  assert.notEqual(assembleDossier({ ...inputs, knowledge }).dossierHash, dossier.dossierHash);

  // The hash is the canonical JSON's: keys sorted at every depth, arrays kept in order.
  assert.equal(
    canonicalJson({ b: [{ d: null, c: "x" }, 2], a: 1 }),
    '{"a":1,"b":[{"c":"x","d":null},2]}',
  );
  const { dossierHash, ...body } = dossier;
  assert.equal(hashOf(Object.fromEntries(Object.entries(body).reverse())), dossierHash);
});

test("a lead without events has an empty why now and still builds; so does one with nothing but a name", () => {
  const dossier = assembleDossier({ ...inputs, events: [] });
  assert.deepEqual(dossier.whyNow, []);
  assert.equal(dossier.facts.length, 15);
  assert.deepEqual(dossierSchema.parse(dossier), dossier);

  // A service principal, an empty Company Knowledge and no linked company: the employer the
  // profile names stands in for the company.
  const knowledge = {
    id: "ck_01EMPTY",
    oneLiner: "",
    products: [],
    painPoints: [],
    proofPoints: [],
  };
  const person = { ...inputs.person, headline: null, title: null, locationText: null };
  const bare = assembleDossier({ sender: null, knowledge, person, company: null, events: [] });
  assert.deepEqual(
    { sender: bare.sender, company: bare.company, facts: bare.facts },
    {
      sender: { name: null },
      company: { name: "Acme", industry: null, sizeRange: null, country: null },
      facts: [
        { id: "f_1", kind: "name", value: "Ines", sourceRef: `${per}/first_name` },
        { id: "f_2", kind: "company", value: "Acme", sourceRef: `${per}/company_name` },
      ],
    },
  );
});

test("assembling the fixture's dossier takes under 100 ms, the median of five runs", () => {
  const runs = Array.from({ length: 5 }, () => {
    const start = performance.now();
    assembleDossier(inputs);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  const median = runs[2] ?? Number.POSITIVE_INFINITY;
  assert.ok(median < 100, `the median run took ${median} ms`);
});
