// signals' evidence route end to end (alpha-p8-030, alpha-p8-050; core/modules/signals/README.md
// "API"): the host started with identity, contacts and signals, on the fake authentication adapter,
// in a schema of the worktree's database, answering real HTTP; the persons and leads written by
// contacts' commands, the sources and events by signals' test factories. It lives here: a module
// never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// signals by its build's path, as src/modules.generated.ts loads it (signals-sources.test.ts).
const build = new URL("../../../../modules/signals/dist/", import.meta.url);
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
const testing: SignalsTesting = await import(new URL("testing/index.js", build).href);

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "contacts", load: () => import("@whytide/contacts") },
      { name: "signals", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

/** A person of the tenant's workspace, written by contacts, with a lead from these sources' ids. */
const personOf = ({ workspace }: TestTenant, slug: string, sourceIds: string[] = []) =>
  withTenant(
    { workspaceId: workspace.id, principal: servicePrincipal("signals_test") },
    async () => {
      const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, title: "Head of Data" };
      const source = { source: "import", provider: "csv", profile } as const;
      const personId = (await upsertPersonFromSource(source)).person.id;
      for (const ref of sourceIds) {
        await createLeadForPerson({ personId, source: { kind: "signal", ref } });
      }
      return personId;
    },
    { client: asRole("app") },
  );

/** GET …/signals/leads/{personId}/evidence of the tenant's workspace, signed in as its user. */
async function evidenceOf(tenant: TestTenant, personId: string) {
  const cookie = signInAs(tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const path = `/v1/workspaces/${tenant.workspace.id}/signals/leads/${personId}/evidence`;
  const res = await fetch(new URL(path, api.url), { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET …/signals/leads/{personId}/evidence answers the person's events newest first, each with its evidence and its source's label, and the lead's first source and the others; none and no attribution for a person without a lead; 404 for another workspace's person", async () => {
  const [a, b] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const launch = await testing.createSignalSource({ workspaceId, label: "Launch post" });
  const webinar = await testing.createSignalSource({ workspaceId, label: "Webinar post" });
  const ours = await personOf(a, "ines", [launch.id, webinar.id]);
  const quiet = await personOf(a, "quiet");
  const theirs = await personOf(b, "ines");
  const at = (day: number) => new Date(`2026-10-0${day}T09:00:00.000Z`);
  const older = await testing.createSignalEvent({
    ...{ workspaceId, personId: ours, occurredAt: at(1), sourceId: launch.id },
  });
  const comment = "Exactly our problem.";
  const newer = await testing.createSignalEvent({
    ...{ workspaceId, personId: ours, occurredAt: at(2), commentText: comment },
    sourceId: webinar.id,
  });
  await testing.createSignalEvent({ workspaceId: b.workspace.id, personId: theirs });

  const { status, body } = await evidenceOf(a, ours);
  assert.equal(status, 200);
  const [first, second] = body.events as Record<string, unknown>[];
  assert.deepEqual(first, {
    ...{ id: newer.id, kind: "post_engagement", sourceId: webinar.id, sourceLabel: "Webinar post" },
    runId: null,
    occurredAt: at(2).toISOString(),
    evidence: {
      ...{ url: newer.evidence?.url, excerpt: comment, commentText: comment },
      ...{ reaction: "comment", author: "Test Engager", capturedAt: at(2).toISOString() },
      reducedAt: null,
    },
  });
  assert.deepEqual(
    [second?.id, second?.sourceLabel, (second?.evidence as { reaction: string }).reaction],
    [older.id, "Launch post", "like"],
  );
  assert.deepEqual(body.attribution, {
    first: { kind: "signal", label: "Launch post" },
    others: [{ kind: "signal", label: "Webinar post" }],
  });
  assert.deepEqual(await evidenceOf(a, quiet), {
    status: 200,
    body: { events: [], attribution: null },
  });
  assert.deepEqual(await evidenceOf(a, theirs), {
    status: 404,
    body: { code: "person_not_found" },
  });
});

test("a lead added by hand (contacts' manual source, lead-manual-create) without an event: the attribution names it first, without a label, and an import that came after among the others", async () => {
  const [a] = await createTwoWorkspaces();
  const personId = await personOf(a, "hana-hand");
  await withTenant(
    { workspaceId: a.workspace.id, principal: servicePrincipal("signals_test") },
    async () => {
      await createLeadForPerson({ personId, source: { kind: "manual", ref: a.user.id } });
      await createLeadForPerson({ personId, source: { kind: "imported", ref: "job_1" } });
    },
    { client: asRole("app") },
  );
  assert.deepEqual(await evidenceOf(a, personId), {
    status: 200,
    body: {
      events: [],
      attribution: {
        first: { kind: "manual", label: null },
        others: [{ kind: "imported", label: null }],
      },
    },
  });
});

test("a Web research event (gamma-wr-061) answers the page the person was found on and the found company's reasons as kept, with no reaction, author or words; the LinkedIn events' answer has no research field; another workspace's research evidence is never read", async () => {
  const [a, b] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const source = await testing.createSignalSource({
    ...{ workspaceId, label: "Cold rooms", kind: "web_research" },
    config: { focus: "sellers of cold rooms" },
    senderAccountId: null,
  });
  const page = "https://frio-aurora.example/team";
  const reasons = [
    {
      ...{ kind: "focus", answer: "shown" },
      line: "Sells cold rooms to restaurants.",
      quote: "vende câmaras frigoríficas para restaurantes",
      url: "https://frio-aurora.example/",
      readAt: "2026-11-19T09:00:00.000Z",
    },
    {
      ...{ kind: "must_have", answer: "shown", criterion: "Delivers with its own vans" },
      line: "Own vans.",
      quote: "Entregamos com as nossas próprias vans",
      url: "https://frio-aurora.example/",
      readAt: "2026-11-19T09:00:00.000Z",
    },
  ];
  const company = await testing.createFoundCompany({
    ...{ workspaceId, sourceId: source.id, domain: "frio-aurora.example", reasons },
    name: "Frio Aurora Ltda",
  });
  const person = await personOf(a, "marina-research", [source.id]);
  const research = await testing.createSignalEvent({
    ...{ workspaceId, personId: person, sourceId: source.id, url: page },
    research: { foundCompanyId: company.id },
  });
  const { status, body } = await evidenceOf(a, person);
  assert.equal(status, 200);
  assert.deepEqual(body.events, [
    {
      ...{ id: research.id, kind: "web_research", sourceId: source.id, sourceLabel: "Cold rooms" },
      runId: null,
      occurredAt: research.occurredAt.toISOString(),
      evidence: null,
      research: {
        url: page,
        company: {
          name: "Frio Aurora Ltda",
          domain: "frio-aurora.example",
          reasons: [
            {
              ...{ kind: "focus", criterion: null, line: "Sells cold rooms to restaurants." },
              quote: "vende câmaras frigoríficas para restaurantes",
              url: "https://frio-aurora.example/",
            },
            {
              ...{ kind: "must_have", criterion: "Delivers with its own vans", line: "Own vans." },
              quote: "Entregamos com as nossas próprias vans",
              url: "https://frio-aurora.example/",
            },
          ],
        },
      },
    },
  ]);
  assert.deepEqual(body.attribution, {
    first: { kind: "signal", label: "Cold rooms" },
    others: [],
  });

  // A profile found by a web search (gamma-wr-070) says so on its event, and only then.
  const searched = await personOf(a, "marina-by-search", [source.id]);
  await testing.createSignalEvent({
    ...{ workspaceId, personId: searched, sourceId: source.id, url: page },
    research: { foundCompanyId: company.id, foundBy: "search" },
  });
  const found = (await evidenceOf(a, searched)).body.events as { research: { foundBy?: string } }[];
  assert.deepEqual(
    found.map((event) => event.research.foundBy),
    ["search"],
  );

  // A person found by the search of the company's managers (gamma-wr-090) says so, with the result's
  // title and the company's site as the page; once the evidence is reduced the title is gone.
  const site = "https://frio-aurora.example/";
  const title = "Rafael Duarte - Diretor de Operações - Frio Aurora | LinkedIn";
  const manager = await personOf(a, "rafael-by-managers", [source.id]);
  await testing.createSignalEvent({
    ...{ workspaceId, personId: manager, sourceId: source.id, url: site, ownWords: title },
    research: { foundCompanyId: company.id, foundBy: "managers" },
  });
  const managed = (await evidenceOf(a, manager)).body.events as { research: object }[];
  assert.deepEqual(
    managed.map(({ research }) => ({ ...research, company: undefined })),
    [{ url: site, foundBy: "managers", title, company: undefined }],
  );
  const reduced = await personOf(a, "rafael-reduced", [source.id]);
  await testing.createSignalEvent({
    ...{ workspaceId, personId: reduced, sourceId: source.id, url: site, ownWords: title },
    ...{ research: { foundCompanyId: company.id, foundBy: "managers" }, reducedAt: new Date() },
  });
  const gone = (await evidenceOf(a, reduced)).body.events as { research: { title?: string } }[];
  assert.deepEqual(
    gone.map(({ research }) => [research.title, "title" in research]),
    [[undefined, false]],
  );

  // A LinkedIn event of the same person has no `research` field at all.
  await testing.createSignalEvent({ workspaceId, personId: person });
  const mixed = (await evidenceOf(a, person)).body.events as Record<string, unknown>[];
  assert.deepEqual(mixed.map((event) => "research" in event).sort(), [false, true]);

  // Workspace B reads none of A's: A's person is a 404 for B, and B's own research event that names
  // A's company has no company to show.
  assert.deepEqual(await evidenceOf(b, person), {
    status: 404,
    body: { code: "person_not_found" },
  });
  const theirs = await personOf(b, "marina-research");
  await testing.createSignalEvent({
    ...{ workspaceId: b.workspace.id, personId: theirs, url: page },
    research: { foundCompanyId: company.id },
  });
  const other = (await evidenceOf(b, theirs)).body.events as { research: unknown }[];
  assert.deepEqual(
    other.map((event) => event.research),
    [{ url: page, company: null }],
  );
});
