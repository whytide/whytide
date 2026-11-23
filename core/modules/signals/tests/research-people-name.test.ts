// The work address of a picked person no page keyed (README.md "Web research"; gamma-wr-080): the
// key's order (the page's own key, then the profile one search found, then an address looked up for the
// name), on the finder, verifier, credits, LLM, search and files fakes, with the companies' pages in
// the run's files (no site is read). Two made-up businesses in two countries and two languages. A
// person whose name finds a `valid` address becomes a lead keyed by it, with its contact point, no
// email lookup asked and no request, counted `people_addresses`; one with no valid address leaves
// nothing, and the run counts them `people_no_key`. The switch off asks nobody; a person the workspace
// holds, a second run and the credit's key are covered too.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.PROVIDER_LLM = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_EMAIL_FINDER = "fake";
process.env.PROVIDER_EMAIL_VERIFIER = "fake";
process.env.SIGNALS_RESEARCH_COMPANIES_PER_RUN = "5";
process.env.SIGNALS_RESEARCH_PEOPLE_PER_COMPANY = "4";
process.env.COST_PRICES_JSON = JSON.stringify({
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
});
const { loadAgentTasks } = await import("@whytide/ai");
const contacts = await import("@whytide/contacts");
const { useHashSalt } = await import("@whytide/contacts/testing");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { useEmailLists, useEnrichmentClient, useSiteHome, useWebSearchAdapters } = await import(
  "@whytide/enrichment/testing"
);
const { readIcpForScoring } = await import("@whytide/icp");
const platform = await import("@whytide/platform");
const { emailFinderPort, emailVerifierPort, filesConfig, filesPort, getAdapter, llmPort } =
  await import("@whytide/providers");
const { webSearchPort } = await import("@whytide/providers");
const { judgeQueueKey, siteKey } = await import("../domain/research/files.ts");
const { splitPersonName } = await import("../domain/research/people-name.ts");
const { queuePeople, takePeople } = await import("../domain/research/people.ts");
const { writeRunFile } = await import("../domain/runs.ts");
const { createFoundCompany, createResearchCandidate, createSignalRun, createSignalSource } =
  await import("../testing/index.ts");
const { useLookupAtFind } = await import("../testing/index.ts");
const { useClient } = await import("../domain/client.ts");

type Llm = import("@whytide/providers").LlmFake;
type Fake = { reset(): void } & {
  readonly recordedCalls: readonly { readonly method: string; readonly input: unknown }[];
};
type Read = import("../schemas/research-read-people.ts").ResearchReadPeopleOutput;
withTestDb();
const app = asRole("app");
useClient(app);
useEnrichmentClient(app);
useHashSalt("test-salt-".repeat(4));
useEmailLists({ sources: ["email-finder"], finders: ["fake"], verifiers: ["fake"] });
// A site that cannot be reached: the pages are the run's files.
useSiteHome(() => new URL("http://127.0.0.250:9/"));
await loadAgentTasks([
  new URL("../agents/research-read-people/task.ts", import.meta.url).href,
  new URL("../agents/research-pick-people/task.ts", import.meta.url).href,
]);
const llm = (await getAdapter(llmPort, "fake")) as unknown as Llm;
const files = (await getAdapter(filesPort, filesConfig.PROVIDER_FILES)) as unknown as Fake;
const finder = (await getAdapter(emailFinderPort, "fake")) as unknown as Fake;
const verifier = (await getAdapter(emailVerifierPort, "fake")) as unknown as Fake & {
  verdictFor(address: string, verdict: string): void;
};
const search = (await getAdapter(webSearchPort, "fake")) as unknown as Fake & {
  seedResults(query: string, results: object[]): void;
};
const principal = platform.servicePrincipal("signals_test");
const tenantOf =
  (workspaceId: string) =>
  <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });

/** The credits' reservations (their keys), commits and releases. */
const credits = { reserved: [] as { key: string; subject: string }[], committed: 0, released: 0 };
platform.bindCreditsClient({
  reserve: async ({ idempotencyKey, subjectRef }) => {
    credits.reserved.push({ key: idempotencyKey, subject: subjectRef });
    return { usageId: `usage_${credits.reserved.length}`, credits: "1" };
  },
  commit: async (usageId) => {
    credits.committed += 1;
    return { usageId, credits: "1" };
  },
  release: async () => {
    credits.released += 1;
  },
  balance: async () => assert.fail("no balance is read"),
  priceOf: async () => assert.fail("no price is read"),
});
beforeEach(() => {
  llm.reset();
  files.reset();
  finder.reset();
  verifier.reset();
  search.reset();
  credits.reserved = [];
  credits.committed = credits.released = 0;
});

type Company = {
  domain: string;
  name: string;
  country: string;
  /** What the company's own page says: names and roles, links and addresses. */
  text: string;
  links?: string[];
};
const NL: Company = {
  ...{ domain: "zonnebloem-verf.example", name: "Zonnebloem Verf", country: "NL" },
  text: "Joris Bakker, Directeur. joris.bakker@zonnebloem-verf.example. Femke de Vries, Hoofd Inkoop. Sander Visser, Commercieel Directeur. Noor Jansen, Manager Verkoop.",
  links: ["https://www.linkedin.com/in/femke-de-vries-zv/"],
};
const PL: Company = {
  ...{ domain: "ostoja-meble.example", name: "Ostoja Meble", country: "PL" },
  text: "Kasia Wrona, Dyrektor Handlowy. Marek Zielinski, Kierownik Zakupow.",
};
const entry = (page: number, name: string, role: string, over: object = {}): Read["people"][0] => ({
  ...{ page, name, role, profile: null, email: null, phone: null, place: null },
  ...over,
});
const FOCUS = "makers of paint and furniture";

/** A workspace with a research source and an audience that wants directors and managers. */
async function world(tag: string, company: Company) {
  const workspaceId = `wsp_name${tag}`;
  const source = await createSignalSource({
    ...{ workspaceId, label: `Makers ${tag}`, kind: "web_research" },
    config: { focus: FOCUS, region: "the Netherlands and Poland" },
    senderAccountId: null,
  });
  const { id } = (await tenantOf(workspaceId)(() => readIcpForScoring(workspaceId))).icp;
  await app.icp.update({
    where: { id },
    data: { titles: ["Directeur", "Dyrektor"], seniorities: ["director", "manager"] },
  });
  const sourceId = source.id;
  const runOf = await createSignalRun({ workspaceId, sourceId, status: "running" });
  const found = await createFoundCompany({
    ...{ workspaceId, sourceId, domain: company.domain, runId: runOf.id, name: company.name },
    ...{ country: company.country, pageUrl: "https://www.linkedin.com/company/x" },
  });
  const candidate = await createResearchCandidate({
    ...{ workspaceId, sourceId, domain: company.domain, runId: runOf.id },
  });
  await writeRunFile(workspaceId, judgeQueueKey(runOf.id), { candidates: [candidate.id] });
  await writeRunFile(workspaceId, siteKey(runOf.id, 1), {
    candidateId: candidate.id,
    pages: [
      {
        url: `https://${company.domain}/team`,
        ...{ title: "Team", text: company.text, mailto: [], links: company.links ?? [] },
      },
    ],
  });
  const inRun = tenantOf(workspaceId);
  const people = async () => {
    const run = await createSignalRun({ workspaceId, sourceId, status: "running" });
    const ref = { workspaceId, sourceId, runId: run.id };
    const queued = await queuePeople(ref, inRun);
    const steps = [];
    for (let index = 1; index <= (queued.status === "queued" ? queued.companies : 0); index += 1)
      steps.push(await takePeople(ref, index, inRun));
    const counts = async () =>
      ((await app.signalRun.findFirstOrThrow({ where: { id: run.id } })).counts ?? {}) as Record<
        string,
        number
      >;
    return { ref, steps, counts };
  };
  const persons = () => app.person.findMany({ where: { workspaceId }, orderBy: { id: "asc" } });
  return { workspaceId, sourceId, found, inRun, people, persons };
}
const picks = (...indexes: number[]) => ({ picks: indexes.map((index) => ({ index })) });
const findCalls = (finderFake: Fake) =>
  finderFake.recordedCalls.filter(({ method }) => method === "findEmail").map(({ input }) => input);
const checked = () =>
  verifier.recordedCalls
    .filter(({ method }) => method === "verifyEmail")
    .map(({ input }) => (input as { address: string }).address);

test("the key's order: a printed address or profile first, then the profile one search found, then an address looked up for the name; only the last asks a finder and a verifier, and that lead has its address, no lookup at find and no request", async () => {
  const world1 = await world("order", NL);
  const found = world1.found.id;
  llm.script(
    {
      people: [
        entry(1, "Joris Bakker", "Directeur", { email: "joris.bakker@zonnebloem-verf.example" }),
        entry(1, "Femke de Vries", "Hoofd Inkoop", {
          profile: "https://www.linkedin.com/in/femke-de-vries-zv/",
        }),
        entry(1, "Sander Visser", "Commercieel Directeur"),
        entry(1, "Noor Jansen", "Manager Verkoop"),
      ],
    },
    picks(1, 2, 3, 4),
  );
  search.seedResults('"Sander Visser" "Zonnebloem Verf"', [
    {
      url: "https://www.linkedin.com/in/sander-visser-zv",
      title: "Sander Visser - Commercieel Directeur - Zonnebloem Verf | LinkedIn",
      snippet: "",
    },
  ]);
  useWebSearchAdapters(["fake"]);
  let run: Awaited<ReturnType<typeof world1.people>>;
  try {
    run = await world1.people();
  } finally {
    useWebSearchAdapters(undefined);
  }
  assert.deepEqual(run.steps, [{ status: "taken", found: 4 }]);
  // Only Noor's name went to a finder, and only her address to a verifier.
  assert.deepEqual(findCalls(finder), [
    { firstName: "Noor", lastName: "Jansen", companyDomain: NL.domain },
  ]);
  assert.deepEqual(checked(), ["noor.jansen@zonnebloem-verf.example"]);
  const persons = await world1.persons();
  assert.equal(persons.length, 4);
  const noor = persons.find(({ firstName }) => firstName === "Noor");
  assert.equal(noor?.linkedinUrl, null);
  const point = await app.contactPoint.findFirstOrThrow({ where: { personId: noor?.id } });
  assert.deepEqual(
    [point.value, point.kind, point.verification, point.status, point.sourceClass],
    ["noor.jansen@zonnebloem-verf.example", "work_email", "valid", "active", "email_finder"],
  );
  assert.equal(
    await app.lead.count({ where: { workspaceId: world1.workspaceId, personId: noor?.id } }),
    1,
  );
  assert.equal(await app.contactPoint.count({ where: { workspaceId: world1.workspaceId } }), 1);
  // The three keyed by the page or by search are asked their email lookup; Noor's lead has its address.
  const requests = await app.enrichmentRequest.findMany({
    where: { workspaceId: world1.workspaceId },
  });
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ personId }) => personId !== noor?.id));
  assert.deepEqual(await run.counts(), {
    ...{ people_companies: 1, people_read: 4, people_picked: 4, people_found: 4 },
    ...{ people_addresses: 1, people_lookups: 3, people_profiles: 1, searches_asked: 2 },
  });
  // One credit, for the found company and Noor's place in the pick, committed.
  assert.deepEqual(
    credits.reserved.map(({ key, subject }) => ({
      key: key.replace(/:[0-9a-f]{32}$/, ""),
      subject,
    })),
    [{ key: `enr:name:${found}:4`, subject: found }],
  );
  assert.deepEqual([credits.committed, credits.released], [1, 0]);
  // Every lead was announced once.
  const announced = (await app.outboxEntry.findMany({ where: { workspaceId: world1.workspaceId } }))
    .filter(({ eventName }) => eventName === "signals.person_found")
    .flatMap(({ payload }) => (payload as { personIds: string[] }).personIds);
  assert.deepEqual(announced.sort(), persons.map(({ id }) => id).sort());
});

test("with no valid address nothing of the person is kept: no person, lead, contact point, request or cache entry for them, the credit released, and the run counts the person with no key", async () => {
  const world1 = await world("none", PL);
  llm.script(
    {
      people: [
        entry(1, "Kasia Wrona", "Dyrektor Handlowy"),
        entry(1, "Marek Zielinski", "Kierownik Zakupow"),
      ],
    },
    picks(1, 2),
  );
  verifier.verdictFor("kasia.wrona@ostoja-meble.example", "invalid");
  verifier.verdictFor("marek.zielinski@ostoja-meble.example", "catch_all");
  const run = await world1.people();
  assert.deepEqual(run.steps, [{ status: "taken", found: 0 }]);
  assert.equal((await world1.persons()).length, 0);
  for (const table of [
    app.lead,
    app.contactPoint,
    app.enrichmentRequest,
    app.enrichmentCacheEntry,
    app.personEmailHash,
  ] as const) {
    assert.equal(await (table as typeof app.lead).count(), 0);
  }
  const counts = await run.counts();
  assert.deepEqual(
    [counts.people_no_key, counts.people_addresses, counts.people_found],
    [2, undefined, undefined],
  );
  assert.deepEqual([credits.reserved.length, credits.committed, credits.released], [2, 0, 2]);
  assert.deepEqual(
    (await app.signalEvent.findMany({ where: { workspaceId: world1.workspaceId } })).length,
    0,
  );
  const stored = JSON.stringify([counts, await app.outboxEntry.findMany({})]).toLowerCase();
  for (const word of ["kasia", "wrona", "marek", "zielinski", "ostoja-meble.example"]) {
    assert.ok(!stored.includes(word), word);
  }
});

test("with ENRICHMENT_LOOKUP_AT_FIND off no name is asked of a finder, and the people with no key are counted as before", async () => {
  const world1 = await world("off", PL);
  llm.script({ people: [entry(1, "Kasia Wrona", "Dyrektor Handlowy")] }, picks(1));
  useLookupAtFind(false);
  try {
    const run = await world1.people();
    assert.deepEqual(run.steps, [{ status: "taken", found: 0 }]);
    assert.equal((await run.counts()).people_no_key, 1);
  } finally {
    useLookupAtFind(undefined);
  }
  assert.deepEqual([findCalls(finder), checked(), credits.reserved.length], [[], [], 0]);
});

test("a person the workspace holds at the company is not asked for, and a second run takes nobody again and asks no finder", async () => {
  const world1 = await world("held", NL);
  const companyId = await world1.inRun(async () => {
    const { company } = await contacts.upsertCompany({
      ...{ source: "website", provider: "website" },
      company: { name: NL.name, domain: NL.domain },
    });
    const { person } = await contacts.upsertPersonFromSource({
      ...{ source: "linkedin", provider: null },
      profile: {
        linkedinUrl: "https://www.linkedin.com/in/noor-jansen-held",
        ...{ firstName: "Noor", lastName: "Jansen" },
      },
    });
    await contacts.linkPersonToCompany({ personId: person.id, companyId: company.id });
    const earlier = {
      kind: "signal" as const,
      ref: "src_earlier",
      at: new Date(),
      label: "Earlier",
    };
    await contacts.createLeadForPerson({ personId: person.id, source: earlier });
    return company.id;
  });
  await app.signalFoundCompany.update({ where: { id: world1.found.id }, data: { companyId } });
  const read = {
    people: [
      entry(1, "Noor Jansen", "Manager Verkoop"),
      entry(1, "Sander Visser", "Commercieel Directeur"),
    ],
  };
  llm.script(read, picks(1, 2));
  const first = await world1.people();
  assert.deepEqual(first.steps, [{ status: "taken", found: 1 }]);
  assert.deepEqual(findCalls(finder), [
    { firstName: "Sander", lastName: "Visser", companyDomain: NL.domain },
  ]);
  const second = await world1.people();
  assert.deepEqual(second.steps, []);
  assert.equal(findCalls(finder).length, 1);
  assert.equal((await world1.persons()).length, 2);
});

test("a name is split as contacts splits it, so that the names the lookup guesses from are the person's own", async () => {
  const names = [
    "Femke de Vries",
    "Noor Jansen",
    "  Kasia   Wrona  ",
    "Cher",
    "Ana María García-López",
  ];
  for (const name of names) {
    const { person } = await tenantOf("wsp_namesplit")(() =>
      contacts.upsertPersonFromSource({
        ...{ source: "import", provider: "csv" },
        profile: { name, linkedinUrl: `https://www.linkedin.com/in/split-${names.indexOf(name)}` },
      }),
    );
    const { firstName, lastName } = splitPersonName(name);
    assert.deepEqual([person.firstName ?? "", person.lastName ?? ""], [firstName, lastName], name);
  }
});
