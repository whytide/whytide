// The email lookup end to end (gamma-en-080; core/modules/enrichment/README.md "Email lookups"), on
// the slice's Temporal and a schema of its database, with enrichment's clock fixed: the credits and
// enrichment modules loaded from their builds by the worker's own loader, their activities through
// the host's wrapper, on the email-finder and email-verifier fakes, a second finder and verifier and
// four email sources defined here. Two finders, the first's candidate invalid and the second's kept
// and charged; catch_all and the domain kept for every workspace; the most candidates verified; the
// verifiers' turns and their allowances; a finder's own invalid; every failure skipped; a personal
// address from the lead's own source, and the owner's UK and EU switch; one address on one person;
// the free ends and a request asked again; a bounce; the re-verifications; through the host, one
// request and one workflow per key. No address in a history, providers_tried, an event or a log
// line, and no candidate's file left. `pnpm -F worker test:replay` replays the two histories
// recorded from here.
// gamma-en-087: the email source linkedin-contact-info on the LinkedIn fake, through the account the
// lead accepted: on, the lead's addresses proposed, the company's domain first, kept on valid with
// the class linkedin_contact_info, a US lead's gmail.com one as personal_email, one read_profile
// read; a lead not connected, not_connected with no call; off, the default, `disabled` with no read
// and no call; switched off after an address was found, the address still answered and kept.
// gamma-en-085: the free sources `reply`, `website` and `pattern` before the finders, on inbox's
// rows and synthetic company pages this test serves on 127.0.0.1.
// gamma-en-100: the lead's own sources first, for a lead with no company domain, one recorded
// catch-all, or a workspace short of credits, nothing reserved; an address the lead gave free.
// gamma-rf-030: a lookup at a domain with two patterns, the most proven guessed first, no third
// guess, a new address counted and a renewed or re-verified one not.
// gamma-wr-070: a lookup at find (the trigger `found`) with the address a page printed with the lead,
// verified before any finder is asked, kept on valid with the class page_printed and charged, on
// invalid the finder asked as before, the address gone from the request at the end and in no history,
// providers_tried, event or log line; the lookups of today unchanged.
// gamma-rf-050: a lead without a LinkedIn profile, known by an address alone, is not_connected for
// linkedin-contact-info, with no call and no read.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Allowance, EmailVerdict, LinkedinFake, RecordedCall } from "@whytide/providers";

// The fakes whatever the environment names: the providers' config reads them as it loads, below.
process.env.PROVIDER_COMPANY_DATA = "fake";
process.env.PROVIDER_EMAIL_FINDER = "fake";
process.env.PROVIDER_EMAIL_VERIFIER = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_LINKEDIN = "fake";

// A company's site (gamma-en-085): acme.example's home page and its team page; any other domain's
// home page is missing. The platform's egress config reads the allow-list as it loads, below.
const SITE: Record<string, string> = {
  "/acme/": `<html><body><h1>Acme Robotics</h1><a href="/acme/team">Our team</a></body></html>`,
  "/acme/team": `<html><body><p>John Smith, john.smith@acme.example</p>
    <p>Lena Park, lena.park@acme.example</p><p>Questions: info@acme.example</p></body></html>`,
};
const served: string[] = [];
const site = createServer((req, res) => {
  served.push(req.url ?? "");
  if (req.url === "/robots.txt") return res.writeHead(200).end("User-agent: *\nAllow: /\n");
  const body = SITE[req.url ?? ""];
  if (body === undefined) res.writeHead(404).end();
  else res.writeHead(200, { "content-type": "text/html" }).end(body);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
process.env.EGRESS_ALLOW_HOSTS = new URL(origin).host;
after(() => {
  site.closeAllConnections();
  site.close();
});

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const providers = await import("@whytide/providers");
const {
  createFake,
  defineAdapter,
  emailFinderPort,
  emailVerifierPort,
  filesPort,
  getAdapter,
  linkedinPort,
} = providers;
const { ids: creditsIds } = await import("@whytide/credits");
const { grantAllowance, useCreditsClient } = await import("@whytide/credits/testing");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { start } = await import("../src/start.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");

// The modules by their builds' paths, as the loader imports them.
const built = (file: string) => import(new URL(`../../../modules/${file}`, import.meta.url).href);
type Contacts = typeof import("../../../modules/contacts/dist/index.js");
type ContactsTesting = typeof import("../../../modules/contacts/dist/testing/index.js");
type Enrichment = typeof import("../../../modules/enrichment/dist/index.js");
type EnrichmentTesting = typeof import("../../../modules/enrichment/dist/testing/index.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type InboxTesting = typeof import("../../../modules/inbox/dist/testing/index.js");
type EmailSourceInput = import("../../../modules/enrichment/dist/index.js").EmailSourceInput;
const contacts: Contacts = await built("contacts/dist/index.js");
const { useHashSalt }: ContactsTesting = await built("contacts/dist/testing/index.js");
const enrichment: Enrichment = await built("enrichment/dist/index.js");
const testing: EnrichmentTesting = await built("enrichment/dist/testing/index.js");
const { createContactPoint, useClock, useEmailLists, usePersonalEmailEuUk, useSiteHome } = testing;
const { createMessage, createThread }: InboxTesting = await built("inbox/dist/testing/index.js");
// A domain's home page is this test's site, under its first label.
useSiteHome((domain) => new URL(`${origin}/${domain.split(".")[0]}/`));
const { createOrganizationWithWorkspace, useTenancyClient }: TenancyTesting = await built(
  "tenancy/dist/testing/index.js",
);
const linkedinTesting: LinkedinTesting = await built("linkedin/dist/testing/index.js");
// The worker's decrypt entry for readContactEmails, registered as the worker registers it on loading.
await built("linkedin/dist/workflows/index.js");

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
testing.useEnrichmentClient(app);
useTenancyClient(app);
useCreditsClient(app);
const NOW = new Date("2026-11-13T10:00:00Z");
const DAY_MS = 86_400_000;
let clock = NOW;
useClock(() => clock);
linkedinTesting.useClock(() => clock);
linkedinTesting.useLinkedinClient(app);
linkedinTesting.useSecretKeys(platform.loadMasterKeys({ APP_MASTER_KEY: platform.newMasterKey() }));
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const names = new Set(["credits", "enrichment"]);
const loaded = await loadModules(moduleLoaders.filter(({ name }) => names.has(name)));
// As the host does before it polls: credits binds its client, enrichment warns to this file's log.
for (const { onWorkerStart } of loaded.starts) await onWorkerStart({ log });
// Inbox's start gives enrichment's `reply` source its reader (gamma-en-085), as the host's does.
type InboxWorkflows = typeof import("../../../modules/inbox/dist/workflows/index.js");
const inboxWorkflows: InboxWorkflows = await built("inbox/dist/workflows/index.js");
await inboxWorkflows.onWorkerStart({ log });
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => [
    name,
    hostActivity(name, definition, { client: app, log }),
  ]),
);

type Controls = {
  readonly recordedCalls: readonly RecordedCall[];
  failNext(code: string): void;
  reset(): void;
  setAllowance(allowance: Allowance | null): void;
};
type FinderFake = Controls & {
  vendorVerdictFor(first: string, last: string, domain: string, verdict: EmailVerdict): void;
};
type VerifierFake = Controls & { verdictFor(address: string, verdict: EmailVerdict): void };
const finder = (await getAdapter(emailFinderPort, "fake")) as unknown as FinderFake;
const verifier = (await getAdapter(emailVerifierPort, "fake")) as unknown as VerifierFake;
const files = await getAdapter(filesPort, "fake");
const linkedinFake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;

/** A second finder: the address a test gives for a domain, else none. */
const secondFinder = createFake(emailFinderPort, {
  state: () => ({ addresses: new Map<string, string>() }),
  methods: (self) => ({
    findEmail: async ({ companyDomain }) => {
      const address = self.state.addresses.get(companyDomain);
      return address ? { result: "found" as const, address } : { result: "not_found" as const };
    },
  }),
  helpers: (self) => ({
    answer: (domain: string, address: string): void => {
      self.state.addresses.set(domain, address);
    },
  }),
});
defineAdapter(emailFinderPort, { name: "second", create: () => secondFinder });
/** A second verifier: `valid` unless a test set another verdict; no allowance. */
const secondVerifier = createFake(emailVerifierPort, {
  state: () => ({ verdicts: new Map<string, EmailVerdict>() }),
  methods: (self) => ({
    verifyEmail: async ({ address }) => ({
      verdict: self.state.verdicts.get(address) ?? "valid",
      checkedAt: new Date(),
    }),
  }),
  helpers: () => ({}),
});
defineAdapter(emailVerifierPort, { name: "second", create: () => secondVerifier });

/** The addresses each person's own sources propose, by person id. */
const proposals = new Map<string, string[]>();
const asked: EmailSourceInput[] = [];
const propose = async (input: EmailSourceInput) => {
  asked.push(input);
  const candidates = (proposals.get(input.personId) ?? []).map((address) => ({ address }));
  return candidates.length === 0 ? { found: false as const } : { found: true as const, candidates };
};
// The lead's own addresses, at any domain (as gamma-en-085's `reply`).
enrichment.defineSource({
  name: "test-reply",
  kind: "email",
  activityKind: "db",
  anyDomain: true,
  provenance: { source: "lead_reply", provider: "test-reply" },
  run: propose,
});
// Guesses at the company's domain only.
enrichment.defineSource({
  name: "test-guess",
  kind: "email",
  activityKind: "db",
  provenance: { source: "email_finder", provider: "test-guess" },
  run: propose,
});
enrichment.defineSource({
  name: "test-broken",
  kind: "email",
  activityKind: "db",
  provenance: { source: "email_finder", provider: "test-broken" },
  run: async () => {
    throw new Error("the source broke");
  },
});
// An `ai` source with a one-second timeout that answers after three.
enrichment.defineSource({
  name: "test-slow",
  kind: "email",
  activityKind: "ai",
  timeoutSeconds: 1,
  provenance: { source: "email_finder", provider: "test-slow" },
  run: async (input) => {
    await sleep(3_000);
    return propose(input);
  },
});

const principal = platform.servicePrincipal("enrichment_test");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
const BLUE = { name: "Blue Harbor Labs", domain: "blueharbor.example" };
const WORK = "noor.haddad@blueharbor.example";
const OTHER = "n.haddad@blueharbor.example";
const GMAIL = "noor.haddad.home@gmail.com";
const US = "Austin, United States";
/** What no history, providers_tried, event or log line may hold: the leads' names and addresses. */
const VALUES = ["noor", "haddad", "blueharbor", "gmail", "Noor", "Haddad"];

/** A workspace whose organization has 100 credits, or none; the price a lookup reserves. */
async function workspace(credits = 100): Promise<{ workspaceId: string; organizationId: string }> {
  await asRole("billing_writer").priceListEntry.upsert({
    where: { action_version: { action: "enrichment.work_email", version: 1 } },
    create: {
      id: platform.newId(creditsIds.price_list_entry),
      ...{ action: "enrichment.work_email", credits: 1, unit: "email", version: 1 },
      effectiveFrom: new Date(Date.now() - 60_000),
    },
    update: {},
  });
  const { organization, workspace } = await createOrganizationWithWorkspace();
  if (credits > 0) await grantAllowance([organization.id], credits);
  return { workspaceId: workspace.id, organizationId: organization.id };
}

/** A person, Noor Haddad unless named, at `company` (none: no company) and `locationText`. */
function personAt(
  workspaceId: string,
  slug: string,
  options: {
    company?: { name: string; domain: string } | null;
    locationText?: string;
    firstName?: string;
    lastName?: string;
  } = {},
): Promise<string> {
  const { company = BLUE, locationText = US, firstName = "Noor", lastName = "Haddad" } = options;
  return inRun(workspaceId, async () => {
    const profile = {
      linkedinUrl: `https://linkedin.com/in/${slug}`,
      firstName,
      ...(lastName !== "" && { lastName }),
      locationText,
    };
    const imported = { source: "import", provider: "csv" } as const;
    const { person } = await contacts.upsertPersonFromSource({ ...imported, profile });
    if (company !== null) {
      const { company: stored } = await contacts.upsertCompany({ ...imported, company });
      await contacts.linkPersonToCompany({ personId: person.id, companyId: stored.id });
    }
    return person.id;
  });
}

type Status = { status: string };
const requestRow = (id: string) => app.enrichmentRequest.findUniqueOrThrow({ where: { id } });
/** A request of the person, run to its end on the slice's Temporal; a fresh key unless given. */
async function lookup(
  workspaceId: string,
  personId: string,
  options: {
    reverify?: boolean;
    requestKey?: string;
    workflowId?: string;
    found?: { address?: string };
  } = {},
) {
  const { reverify = false, requestKey = randomUUID(), workflowId, found } = options;
  const asking = { personId, requestKey };
  const foundOptions = found && { trigger: "found" as const, ...found };
  const { requestId } = await inRun(workspaceId, () =>
    reverify
      ? enrichment.requestReverification(asking)
      : enrichment.requestLookup({ ...asking, ...foundOptions }),
  );
  const result = await runWorkflow<Status>(
    "enrichment_lookup",
    { workspaceId, requestId },
    { activities, ...(workflowId !== undefined && { workflowId }) },
  );
  const request = await requestRow(requestId);
  assert.equal(result.status, request.status);
  return { requestId, request };
}
type Tried = { source: string; step: string; outcome: string; code: string | null };
/** providers_tried without the durations, each checked a number. */
const tried = (stored: unknown): Tried[] =>
  (stored as (Tried & { ms: unknown })[]).map(({ ms, ...entry }) => {
    assert.equal(typeof ms, "number");
    return entry;
  });
const step = (source: string, kind: string, outcome: string, code: string | null = null) => ({
  source,
  step: kind,
  outcome,
  code,
});
const usageOf = (requestId: string) =>
  app.creditUsage.findMany({
    where: { subjectRef: requestId },
    select: { status: true, idempotencyKey: true, credits: true },
    orderBy: { createdAt: "asc" },
  });
const usageStatuses = async (requestId: string) =>
  (await usageOf(requestId)).map(({ status }) => status);
const pointsOf = (personId: string) => app.contactPoint.findMany({ where: { personId } });
const cacheOf = (personId: string) =>
  app.enrichmentCacheEntry.findMany({
    where: { personId },
    select: { kind: true, value: true, reason: true, provider: true, expiresAt: true },
  });
const eventsOf = async (workspaceId: string) =>
  (await app.outboxEntry.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }))
    .filter(({ eventName }) => eventName.startsWith("enrichment."))
    .map(({ eventName, payload }) => [eventName, payload]);
const addresses = (calls: readonly RecordedCall[]) =>
  calls.map(({ input }) => (input as { address: string }).address);
const days = (count: number) => new Date(NOW.getTime() + count * DAY_MS);
/** The workflow's history as text, its payloads decoded. */
async function historyOf(workflowId: string): Promise<string> {
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  return JSON.stringify(history).replaceAll(/"data":"([\w+/=]+)"/g, (_, data: string) =>
    Buffer.from(data, "base64").toString("utf8"),
  );
}
const holdsNoValue = (text: string, what: string) => {
  for (const value of VALUES) assert.ok(!text.includes(value), `${what} holds "${value}"`);
};
/** No candidate's file left in the workspace's raw/enrichment/ folder. */
async function noFiles(workspaceId: string): Promise<void> {
  const { files: left } = await files.list({ workspaceId, prefix: "raw/enrichment/" });
  assert.deepEqual(left, []);
}
/** What `read` answers once it answers something, within thirty seconds. */
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, "until: nothing within thirty seconds");
    await sleep(50);
  }
}
const lists = (more: { sources?: string[]; finders?: string[]; verifiers?: string[] }) =>
  useEmailLists({ sources: ["email-finder"], finders: ["fake"], verifiers: ["fake"], ...more });

beforeEach(() => {
  finder.reset();
  verifier.reset();
  secondFinder.reset();
  secondVerifier.reset();
  proposals.clear();
  asked.length = 0;
  clock = NOW;
  useEmailLists(undefined);
  usePersonalEmailEuUk(undefined);
  linkedinFake.reset();
  linkedinTesting.useContactInfoEnabled(undefined);
  logs.raw.length = 0;
  served.length = 0;
});

test("two finders: a's candidate verified invalid makes b asked, b's valid one kept as the person's work address with its provenance, ENRICHMENT_CREDITS_PER_EMAIL committed under enr:<request>:1, the email entry for 120 days and address_verified with ids; the finder gets the three keys and the verifier the address only; no address in the history, providers_tried, an event or a log line, and no file left", async (t) => {
  lists({ finders: ["fake", "second"] });
  const { workspaceId } = await workspace();
  const personId = await personAt(workspaceId, "two-finders");
  verifier.verdictFor(WORK, "invalid");
  secondFinder.answer(BLUE.domain, OTHER);
  const workflowId = `enrichment_lookup-${randomUUID()}`;
  const { requestId, request } = await lookup(workspaceId, personId, { workflowId });
  t.diagnostic(`history: ${workflowId}`);
  assert.deepEqual([request.status, request.reason, request.attempt], ["found", null, 1]);
  assert.deepEqual(tried(request.providersTried), [
    step("email-finder/fake", "find", "found"),
    step("email-finder/fake", "candidate", "kept"),
    step("email-verifier/fake", "verify", "invalid"),
    step("email-finder/second", "find", "found"),
    step("email-finder/second", "candidate", "kept"),
    step("email-verifier/fake", "verify", "valid"),
  ]);
  const [point, ...more] = await pointsOf(personId);
  assert.deepEqual(more, []);
  assert.deepEqual(
    [point?.value, point?.kind, point?.verification, point?.status, point?.sourceClass],
    [OTHER, "work_email", "valid", "active", "email_finder"],
  );
  assert.deepEqual(
    [point?.provider, point?.legalBasis, point?.verifiedAt, point?.acquiredAt],
    ["second", "legitimate_interest", NOW, NOW],
  );
  assert.equal(request.contactPointId, point?.id);
  assert.deepEqual(
    (await usageOf(requestId)).map(({ status, idempotencyKey, credits }) => [
      status,
      idempotencyKey,
      credits.toFixed(),
    ]),
    [["committed", `enr:${requestId}:1`, "1"]],
  );
  assert.equal(request.creditsCharged.toFixed(), "1");
  assert.deepEqual(await cacheOf(personId), [
    { kind: "email", value: OTHER, reason: null, provider: "second", expiresAt: days(120) },
  ]);
  assert.deepEqual(await eventsOf(workspaceId), [
    ["enrichment.lookup_requested", { requestId }],
    ["enrichment.address_verified", { requestId, personId, contactPointId: point?.id }],
  ]);
  const keys = { firstName: "Noor", lastName: "Haddad", companyDomain: BLUE.domain };
  assert.deepEqual(
    [...finder.recordedCalls, ...secondFinder.recordedCalls].map(({ input }) => input),
    [keys, keys],
  );
  assert.deepEqual(addresses(verifier.recordedCalls), [WORK, OTHER]);
  assert.equal(await inRun(workspaceId, () => enrichment.addressOf(point?.id ?? "")), OTHER);
  const work = await inRun(workspaceId, () => enrichment.workEmailOf(personId));
  assert.equal(work?.contactPointId, point?.id);
  holdsNoValue(await historyOf(workflowId), "the lookup's history");
  holdsNoValue(JSON.stringify(request.providersTried), "providers_tried");
  holdsNoValue(JSON.stringify(await eventsOf(workspaceId)), "the events");
  holdsNoValue(logs.raw.join("\n"), "the log");
  await noFiles(workspaceId);
  // The same request run again ends at its prepare: no call, and the credits committed once.
  const again = await runWorkflow<Status>(
    "enrichment_lookup",
    { workspaceId, requestId },
    { activities },
  );
  assert.deepEqual(again, { status: "found" });
  assert.deepEqual([finder.recordedCalls.length, verifier.recordedCalls.length], [1, 2]);
  assert.equal((await usageOf(requestId)).length, 1);
});

test("a lookup at find: the address a page printed with the lead is verified before the finder is asked, kept on valid with the class page_printed and charged, and gone from the request; no finder call, no address in the history, providers_tried, an event or a log line, and no file left", async (t) => {
  lists({});
  const { workspaceId } = await workspace();
  const personId = await personAt(workspaceId, "found-valid");
  const workflowId = `enrichment_lookup-${randomUUID()}`;
  const { requestId, request } = await lookup(workspaceId, personId, {
    found: { address: WORK },
    workflowId,
  });
  t.diagnostic(`history: ${workflowId}`);
  assert.deepEqual([request.trigger, request.status, request.reason], ["found", "found", null]);
  assert.equal(request.printedAddress, null);
  assert.deepEqual(tried(request.providersTried), [
    step("printed", "find", "found"),
    step("printed", "candidate", "kept"),
    step("email-verifier/fake", "verify", "valid"),
  ]);
  const [point, ...more] = await pointsOf(personId);
  assert.deepEqual(more, []);
  assert.deepEqual(
    [point?.value, point?.kind, point?.verification, point?.sourceClass, point?.provider],
    [WORK, "work_email", "valid", "page_printed", "page"],
  );
  assert.deepEqual(addresses(verifier.recordedCalls), [WORK]);
  assert.equal(finder.recordedCalls.length, 0, "a valid printed address asks no finder");
  assert.deepEqual(await usageStatuses(requestId), ["committed"]);
  assert.equal(request.creditsCharged.toFixed(), "1");
  holdsNoValue(await historyOf(workflowId), "the lookup's history");
  holdsNoValue(JSON.stringify(request.providersTried), "providers_tried");
  holdsNoValue(JSON.stringify(await eventsOf(workspaceId)), "the events");
  holdsNoValue(logs.raw.join("\n"), "the log");
  await noFiles(workspaceId);
});

test("a lookup at find: a printed address a verifier calls invalid keeps nothing and the finder is asked as in a lookup of today; with no printed address the lookup is the finder's alone", async () => {
  lists({});
  const { workspaceId } = await workspace();
  const personId = await personAt(workspaceId, "found-invalid");
  verifier.verdictFor(WORK, "invalid");
  finder.reset();
  const { request } = await lookup(workspaceId, personId, { found: { address: WORK } });
  assert.deepEqual(
    [request.status, request.reason, request.printedAddress],
    ["not_found", "not_verified", null],
  );
  assert.equal((await pointsOf(personId)).length, 0);
  assert.equal(finder.recordedCalls.length, 1, "the finder is asked after the printed address");
  assert.equal(request.providersTried?.toString().includes("@"), false);
  const bare = await personAt(workspaceId, "found-bare", { lastName: "Bare" });
  const { request: second } = await lookup(workspaceId, bare, { found: {} });
  assert.deepEqual(
    tried(second.providersTried).map(({ source }) => source),
    ["email-finder/fake", "email-finder/fake", "email-verifier/fake"],
  );
  assert.equal(second.trigger, "found");
});

test("catch_all ends the lookup with no further candidate, records the domain for every workspace for 30 days and releases the credits; a second workspace's lookup at that domain makes no call and reserves nothing", async () => {
  lists({ finders: ["fake", "second"] });
  const first = await workspace();
  const personId = await personAt(first.workspaceId, "catch-all");
  verifier.verdictFor(WORK, "catch_all");
  secondFinder.answer(BLUE.domain, OTHER);
  const { requestId, request } = await lookup(first.workspaceId, personId);
  assert.deepEqual([request.status, request.reason], ["not_found", "catch_all"]);
  assert.deepEqual([secondFinder.recordedCalls.length, verifier.recordedCalls.length], [0, 1]);
  assert.deepEqual(await usageStatuses(requestId), ["released"]);
  const status = await app.emailDomainStatus.findUniqueOrThrow({ where: { domain: BLUE.domain } });
  assert.deepEqual([status.catchAll, status.expiresAt], [true, days(30)]);
  assert.deepEqual(
    (await cacheOf(personId)).map(({ kind, reason, expiresAt }) => [kind, reason, expiresAt]),
    [["negative", "catch_all", days(30)]],
  );

  const second = await workspace();
  const other = await personAt(second.workspaceId, "catch-all-elsewhere");
  const elsewhere = await lookup(second.workspaceId, other);
  assert.deepEqual(
    [elsewhere.request.status, elsewhere.request.reason],
    ["not_found", "catch_all"],
  );
  assert.deepEqual([finder.recordedCalls.length, verifier.recordedCalls.length], [1, 1]);
  assert.deepEqual(await usageOf(elsewhere.requestId), []);
});

test("a catch_all marks the company's own domain only: one at a subdomain of it, or a re-verified address at a former employer's domain, ends catch_all and records no domain for any workspace", async () => {
  lists({ sources: ["test-guess"] });
  const { workspaceId } = await workspace();
  const sub = await personAt(workspaceId, "catch-all-subdomain");
  const atSub = `noor.haddad@mail.${BLUE.domain}`;
  proposals.set(sub, [atSub]);
  verifier.verdictFor(atSub, "catch_all");
  const looked = await lookup(workspaceId, sub);
  assert.deepEqual([looked.request.status, looked.request.reason], ["not_found", "catch_all"]);

  const moved = await personAt(workspaceId, "catch-all-former", { lastName: "Moved" });
  const former = "noor.moved@oldharbor.example";
  await inRun(workspaceId, () =>
    createContactPoint(moved, {
      address: former,
      kind: "work_email",
      sourceClass: "email_finder",
      provider: "fake",
      verifiedAt: days(-300),
    }),
  );
  verifier.verdictFor(former, "catch_all");
  const again = await lookup(workspaceId, moved, { reverify: true });
  assert.deepEqual([again.request.status, again.request.reason], ["not_found", "catch_all"]);
  assert.deepEqual(addresses(verifier.recordedCalls), [atSub, former]);
  assert.equal(await app.emailDomainStatus.count(), 0);
});

test("no lookup verifies more than ENRICHMENT_EMAIL_MAX_CANDIDATES (3) candidates; a finder's own invalid drops its candidate with no verifier call; both end not_verified with their credits released", async () => {
  lists({ sources: ["test-guess", "email-finder"] });
  const { workspaceId } = await workspace();
  const personId = await personAt(workspaceId, "many");
  const guesses = ["a", "b", "c", "d", "e"].map((part) => `${part}.haddad@${BLUE.domain}`);
  proposals.set(personId, guesses);
  for (const address of guesses) verifier.verdictFor(address, "risky");
  const { requestId, request } = await lookup(workspaceId, personId);
  assert.deepEqual([request.status, request.reason], ["not_found", "not_verified"]);
  assert.deepEqual(addresses(verifier.recordedCalls), guesses.slice(0, 3));
  assert.equal(finder.recordedCalls.length, 0);
  assert.deepEqual(await usageStatuses(requestId), ["released"]);

  lists({});
  verifier.reset();
  const vendor = await personAt(workspaceId, "vendor-invalid", { lastName: "Saleh" });
  finder.vendorVerdictFor("Noor", "Saleh", BLUE.domain, "invalid");
  const judged = await lookup(workspaceId, vendor);
  assert.deepEqual([judged.request.status, judged.request.reason], ["not_found", "not_verified"]);
  assert.deepEqual(tried(judged.request.providersTried), [
    step("email-finder/fake", "find", "found"),
    step("email-finder/fake", "candidate", "vendor_invalid"),
  ]);
  assert.equal(verifier.recordedCalls.length, 0);
});

test("the verifiers' turns: with the first's allowance used up the second verifies; a vendor's verifier_allowance_spent marks it spent for the day; with none left the lookup ends waiting_allowance (no_verifier_left), its credits released, the next one so before any credit or finder, and the same key asked the next day runs as attempt 2", async () => {
  lists({ verifiers: ["fake", "second"] });
  const { workspaceId } = await workspace();
  verifier.setAllowance({ calls: 1, per: "day" });
  const one = await personAt(workspaceId, "turn-one", { lastName: "One" });
  const two = await personAt(workspaceId, "turn-two", { lastName: "Two" });
  const three = await personAt(workspaceId, "turn-three", { lastName: "Three" });
  assert.equal((await lookup(workspaceId, one)).request.status, "found");
  const second = await lookup(workspaceId, two);
  assert.equal(second.request.status, "found");
  assert.deepEqual(
    tried(second.request.providersTried).filter(({ step }) => step === "verify"),
    [
      step("email-verifier/fake", "verify", "allowance_spent"),
      step("email-verifier/second", "verify", "valid"),
    ],
  );
  secondVerifier.failNext("verifier_allowance_spent");
  const requestKey = "turns-key";
  const waiting = await lookup(workspaceId, three, { requestKey });
  assert.deepEqual(
    [waiting.request.status, waiting.request.reason],
    ["waiting_allowance", "no_verifier_left"],
  );
  assert.deepEqual(await usageStatuses(waiting.requestId), ["released"]);
  assert.deepEqual(await cacheOf(three), []);
  const usage = await app.sourceUsage.findMany({
    where: { source: { startsWith: "email-verifier/" }, periodStart: "2026-11-13" },
    select: { source: true, periodStart: true, used: true, spent: true },
    orderBy: { source: "asc" },
  });
  assert.deepEqual(usage, [
    { source: "email-verifier/fake", periodStart: "2026-11-13", used: 1, spent: false },
    { source: "email-verifier/second", periodStart: "2026-11-13", used: 2, spent: true },
  ]);
  const missing = (await eventsOf(workspaceId)).at(-1);
  assert.deepEqual(missing, [
    "enrichment.address_missing",
    { requestId: waiting.requestId, personId: three, reason: "no_verifier_left" },
  ]);
  // Every verifier spent for its period: the next lookup waits before any credit or finder.
  finder.reset();
  const four = await personAt(workspaceId, "turn-four", { lastName: "Four" });
  const early = await lookup(workspaceId, four);
  assert.deepEqual(
    [early.request.status, early.request.reason],
    ["waiting_allowance", "no_verifier_left"],
  );
  assert.equal(finder.recordedCalls.length, 0);
  assert.deepEqual(await usageOf(early.requestId), []);
  assert.deepEqual(tried(early.request.providersTried), []);

  clock = days(1);
  const again = await lookup(workspaceId, three, { requestKey });
  assert.deepEqual(
    [again.requestId, again.request.status, again.request.attempt],
    [waiting.requestId, "found", 2],
  );
  assert.deepEqual(
    (await usageOf(again.requestId)).map(({ status, idempotencyKey }) => [status, idempotencyKey]),
    [
      ["released", `enr:${again.requestId}:1`],
      ["committed", `enr:${again.requestId}:2`],
    ],
  );
});

test("a source, finder or verifier that fails for any reason is skipped: a source that throws, one past its timeout, a refused key and a rate limit recorded with their codes and the next asked; every finder failing ends failed (provider_error) and every verifier failing ends failed with the vendor's code, the credits released and no cache entry either way", async () => {
  lists({
    sources: ["test-broken", "test-slow", "email-finder"],
    finders: ["fake", "second"],
    verifiers: ["fake", "second"],
  });
  const { workspaceId } = await workspace();
  const personId = await personAt(workspaceId, "failures");
  finder.failNext("finder_unauthorized");
  secondFinder.answer(BLUE.domain, OTHER);
  verifier.failNext("verifier_rate_limited");
  const { request } = await lookup(workspaceId, personId);
  assert.equal(request.status, "found");
  assert.deepEqual(tried(request.providersTried), [
    step("test-broken", "find", "failed", "activity_failed"),
    step("test-slow", "find", "failed", "activity_timeout"),
    step("email-finder/fake", "find", "failed", "finder_unauthorized"),
    step("email-finder/second", "find", "found"),
    step("email-finder/second", "candidate", "kept"),
    step("email-verifier/fake", "verify", "failed", "verifier_rate_limited"),
    step("email-verifier/second", "verify", "valid"),
  ]);

  lists({});
  const down = await personAt(workspaceId, "finder-down", { lastName: "Down" });
  finder.failNext("finder_provider_error");
  const failed = await lookup(workspaceId, down);
  assert.deepEqual(
    [failed.request.status, failed.request.reason, failed.request.errorCode],
    ["failed", "provider_error", "finder_provider_error"],
  );
  assert.deepEqual(await usageStatuses(failed.requestId), ["released"]);
  assert.deepEqual(await cacheOf(down), []);

  const out = await personAt(workspaceId, "verifier-down", { lastName: "Out" });
  verifier.failNext("verifier_unauthorized");
  const unchecked = await lookup(workspaceId, out);
  assert.deepEqual(
    [unchecked.request.status, unchecked.request.reason, unchecked.request.errorCode],
    ["failed", "provider_error", "verifier_unauthorized"],
  );
  assert.deepEqual(await usageStatuses(unchecked.requestId), ["released"]);
  assert.deepEqual(await cacheOf(out), []);
  await noFiles(workspaceId);
});

test("a personal address: a gmail.com candidate from a source with anyDomain kept as personal_email on valid, the same from a finder dropped other_domain; a UK lead's skipped with no verifier call while ENRICHMENT_PERSONAL_EMAIL_EU_UK is off, and verified once it is on; a catch_all on one drops it, records no domain, and the lookup goes on to the work address", async () => {
  lists({ sources: ["email-finder", "test-reply"], finders: ["second"] });
  const { workspaceId } = await workspace();
  const us = await personAt(workspaceId, "personal-us");
  secondFinder.answer(BLUE.domain, GMAIL);
  proposals.set(us, [GMAIL]);
  const kept = await lookup(workspaceId, us);
  assert.equal(kept.request.status, "found");
  assert.deepEqual(tried(kept.request.providersTried), [
    step("email-finder/second", "find", "found"),
    step("email-finder/second", "candidate", "other_domain"),
    step("test-reply", "find", "found"),
    step("test-reply", "candidate", "kept"),
    step("email-verifier/fake", "verify", "valid"),
  ]);
  const [point] = await pointsOf(us);
  assert.deepEqual(
    [point?.value, point?.kind, point?.sourceClass, point?.provider],
    [GMAIL, "personal_email", "lead_reply", "test-reply"],
  );
  assert.deepEqual(addresses(verifier.recordedCalls), [GMAIL]);

  lists({ sources: ["test-reply", "email-finder"] });
  verifier.reset();
  const uk = await personAt(workspaceId, "personal-uk", { locationText: "London, United Kingdom" });
  const ukGmail = "noor.uk@gmail.com";
  proposals.set(uk, [ukGmail]);
  const work = await lookup(workspaceId, uk);
  assert.equal(work.request.status, "found");
  assert.deepEqual(tried(work.request.providersTried).slice(0, 2), [
    step("test-reply", "find", "found"),
    step("test-reply", "candidate", "personal_needs_consent"),
  ]);
  assert.deepEqual(addresses(verifier.recordedCalls), [WORK]);
  assert.deepEqual(
    (await pointsOf(uk)).map(({ value, kind }) => [value, kind]),
    [[WORK, "work_email"]],
  );

  usePersonalEmailEuUk(true);
  verifier.reset();
  const consented = await personAt(workspaceId, "personal-uk-on", {
    locationText: "London, United Kingdom",
    lastName: "Consent",
  });
  proposals.set(consented, ["noor.on@gmail.com"]);
  const on = await lookup(workspaceId, consented);
  assert.equal(on.request.status, "found");
  assert.deepEqual(addresses(verifier.recordedCalls), ["noor.on@gmail.com"]);
  usePersonalEmailEuUk(undefined);

  verifier.reset();
  const doubtful = await personAt(workspaceId, "personal-catch-all", { lastName: "Doubt" });
  proposals.set(doubtful, ["noor.doubt@gmail.com"]);
  verifier.verdictFor("noor.doubt@gmail.com", "catch_all");
  const goesOn = await lookup(workspaceId, doubtful);
  assert.equal(goesOn.request.status, "found");
  assert.deepEqual(addresses(verifier.recordedCalls), [
    "noor.doubt@gmail.com",
    `noor.doubt@${BLUE.domain}`,
  ]);
  assert.equal(await app.emailDomainStatus.count({ where: { domain: "gmail.com" } }), 0);
  assert.deepEqual(
    (await pointsOf(doubtful)).map(({ kind }) => kind),
    ["work_email"],
  );
});

test("one address never sits on two persons: a valid address another person of the workspace holds ends not_found (held_by_other_person), its credits released and a negative entry left, the first person keeping it; a same-name person after them ends so from the cache, with no call and nothing reserved", async () => {
  lists({ finders: ["second"] });
  const { workspaceId } = await workspace();
  secondFinder.answer(BLUE.domain, OTHER);
  const first = await personAt(workspaceId, "holder-first");
  const second = await personAt(workspaceId, "holder-second", { lastName: "Other" });
  assert.equal((await lookup(workspaceId, first)).request.status, "found");
  const { requestId, request } = await lookup(workspaceId, second);
  assert.deepEqual([request.status, request.reason], ["not_found", "held_by_other_person"]);
  assert.deepEqual(await usageStatuses(requestId), ["released"]);
  assert.deepEqual(
    (await cacheOf(second)).map(({ kind, reason }) => [kind, reason]),
    [["negative", "held_by_other_person"]],
  );
  assert.deepEqual(await pointsOf(second), []);
  assert.deepEqual(
    (await pointsOf(first)).map(({ value }) => value),
    [OTHER],
  );

  const namesake = await personAt(workspaceId, "holder-namesake");
  const calls = secondFinder.recordedCalls.length;
  const cached = await lookup(workspaceId, namesake);
  assert.deepEqual(
    [cached.request.status, cached.request.reason],
    ["not_found", "held_by_other_person"],
  );
  assert.deepEqual(await usageOf(cached.requestId), []);
  assert.equal(secondFinder.recordedCalls.length, calls);
});

test("the free ends, each with no vendor call and nothing reserved: suppressed, an address verified within 120 days, no last name, no company domain; and the credits short end waiting_budget, asked again with credits as attempt 2 under a new reservation key", async () => {
  lists({});
  const { workspaceId, organizationId } = await workspace(0);
  const suppressed = await personAt(workspaceId, "free-suppressed");
  await inRun(workspaceId, () =>
    contacts.addOptOut(suppressed, { source: "system", reason: "reply_opt_out" }),
  );
  const known = await personAt(workspaceId, "free-known", { lastName: "Known" });
  await inRun(workspaceId, () =>
    createContactPoint(known, {
      address: `noor.known@${BLUE.domain}`,
      kind: "work_email",
      sourceClass: "email_finder",
      provider: "fake",
      verifiedAt: days(-100),
    }),
  );
  const nameless = await personAt(workspaceId, "free-nameless", { lastName: "" });
  const homeless = await personAt(workspaceId, "free-homeless", { company: null });
  const ends = [];
  for (const personId of [suppressed, known, nameless, homeless]) {
    const { requestId, request } = await lookup(workspaceId, personId);
    ends.push([request.status, request.reason, (await usageOf(requestId)).length]);
  }
  assert.deepEqual(ends, [
    ["skipped_suppressed", "suppressed", 0],
    ["found", null, 0],
    ["not_found", "no_name", 0],
    ["not_found", "no_domain", 0],
  ]);
  assert.deepEqual([finder.recordedCalls.length, verifier.recordedCalls.length], [0, 0]);

  const broke = await personAt(workspaceId, "free-broke", { lastName: "Broke" });
  const requestKey = "budget-key";
  const waiting = await lookup(workspaceId, broke, { requestKey });
  assert.deepEqual(
    [waiting.request.status, waiting.request.reason],
    ["waiting_budget", "insufficient_credits"],
  );
  assert.equal(finder.recordedCalls.length, 0);
  await grantAllowance([organizationId], 100);
  const again = await lookup(workspaceId, broke, { requestKey });
  assert.deepEqual(
    [again.requestId, again.request.status, again.request.attempt],
    [waiting.requestId, "found", 2],
  );
  assert.deepEqual(
    (await usageOf(again.requestId)).map(({ status, idempotencyKey }) => [status, idempotencyKey]),
    [["committed", `enr:${again.requestId}:2`]],
  );
});

test("markBounced: neither reader answers the address, its email entry becomes a negative one, and a later lookup for the person ends cached_negative with no call", async () => {
  lists({});
  const { workspaceId } = await workspace();
  const personId = await personAt(workspaceId, "bounced");
  const { request } = await lookup(workspaceId, personId);
  const contactPointId = request.contactPointId ?? assert.fail("no address");
  await inRun(workspaceId, () => enrichment.markBounced(contactPointId, { at: NOW }));
  assert.deepEqual(
    await inRun(workspaceId, async () => [
      await enrichment.addressOf(contactPointId),
      await enrichment.workEmailOf(personId),
    ]),
    [null, null],
  );
  assert.deepEqual(
    (await cacheOf(personId)).map(({ kind, reason }) => [kind, reason]),
    [["negative", "bounced"]],
  );
  finder.reset();
  const later = await lookup(workspaceId, personId);
  assert.deepEqual([later.request.status, later.request.reason], ["not_found", "cached_negative"]);
  assert.equal(finder.recordedCalls.length, 0);
});

test("re-verifications send the active address to the verifier whatever its age, never the finder, reserve nothing: valid renews it; invalid and catch_all leave neither reader answering and a negative entry; a person with no address ends no_address with no call; every verifier failing leaves the contact point unchanged", async (t) => {
  lists({});
  const { workspaceId } = await workspace();
  const pointOf = async (slug: string, lastName: string) => {
    const personId = await personAt(workspaceId, slug, { lastName });
    const address = `noor.${lastName.toLowerCase()}@${BLUE.domain}`;
    const { contactPointId } = await inRun(workspaceId, () =>
      createContactPoint(personId, {
        address,
        kind: "work_email",
        sourceClass: "email_finder",
        provider: "fake",
        verifiedAt: days(-300),
      }),
    );
    return { personId, address, contactPointId: contactPointId ?? assert.fail("no point") };
  };
  const renewed = await pointOf("reverify-valid", "Valid");
  const workflowId = `enrichment_lookup_reverify-${randomUUID()}`;
  const valid = await lookup(workspaceId, renewed.personId, { reverify: true, workflowId });
  t.diagnostic(`history: ${workflowId}`);
  assert.deepEqual([valid.request.status, valid.request.trigger], ["found", "reverify"]);
  const point = await app.contactPoint.findUniqueOrThrow({ where: { id: renewed.contactPointId } });
  assert.deepEqual([point.verification, point.verifiedAt], ["valid", NOW]);
  holdsNoValue(await historyOf(workflowId), "the re-verification's history");

  const ends = [];
  for (const verdict of ["invalid", "catch_all"] as const) {
    const { personId, address, contactPointId } = await pointOf(`reverify-${verdict}`, verdict);
    verifier.verdictFor(address, verdict);
    const { request } = await lookup(workspaceId, personId, { reverify: true });
    const read = await inRun(workspaceId, () => enrichment.addressOf(contactPointId));
    const [entry] = await cacheOf(personId);
    ends.push([request.status, request.reason, read, entry?.kind]);
  }
  assert.deepEqual(ends, [
    ["not_found", "not_verified", null, "negative"],
    ["not_found", "catch_all", null, "negative"],
  ]);

  const none = await personAt(workspaceId, "reverify-none", { lastName: "None" });
  const noAddress = await lookup(workspaceId, none, { reverify: true });
  assert.deepEqual(
    [noAddress.request.status, noAddress.request.reason],
    ["not_found", "no_address"],
  );

  const kept = await pointOf("reverify-down", "Down");
  const calls = verifier.recordedCalls.length;
  verifier.failNext("verifier_provider_error");
  const down = await lookup(workspaceId, kept.personId, { reverify: true });
  assert.deepEqual(
    [down.request.status, down.request.errorCode],
    ["failed", "verifier_provider_error"],
  );
  const unchanged = await app.contactPoint.findUniqueOrThrow({
    where: { id: kept.contactPointId },
  });
  assert.deepEqual([unchanged.verification, unchanged.verifiedAt], ["valid", days(-300)]);
  assert.equal(verifier.recordedCalls.length, calls + 1);
  assert.equal(finder.recordedCalls.length, 0);
  assert.equal(await app.creditUsage.count({ where: { workspaceId } }), 0);
});

test("a re-verification of a held personal address of a UK lead, while ENRICHMENT_PERSONAL_EMAIL_EU_UK is off, makes no verifier call and ends not_found (personal_needs_consent) with no negative entry and its contact point unchanged; once the switch is on, it is verified", async () => {
  lists({});
  const { workspaceId } = await workspace();
  const uk = await personAt(workspaceId, "reverify-personal-uk", {
    locationText: "London, United Kingdom",
  });
  const held = "noor.held@gmail.com";
  const { contactPointId } = await inRun(workspaceId, () =>
    createContactPoint(uk, {
      address: held,
      kind: "personal_email",
      sourceClass: "lead_reply",
      provider: "test-reply",
      verifiedAt: days(-300),
    }),
  );
  const off = await lookup(workspaceId, uk, { reverify: true });
  assert.deepEqual(
    [off.request.status, off.request.reason],
    ["not_found", "personal_needs_consent"],
  );
  assert.equal(verifier.recordedCalls.length, 0);
  assert.deepEqual(await cacheOf(uk), []);
  const point = await app.contactPoint.findUniqueOrThrow({ where: { id: contactPointId ?? "" } });
  assert.deepEqual([point.verification, point.verifiedAt], ["valid", days(-300)]);

  usePersonalEmailEuUk(true);
  const on = await lookup(workspaceId, uk, { reverify: true });
  assert.equal(on.request.status, "found");
  assert.deepEqual(addresses(verifier.recordedCalls), [held]);
});

test("through the host: a request writes one enrichment_requests row and one enrichment.lookup_requested with its id only, whose subscriber starts enrichment.lookup:<workspace>:<request>:1 once; the same key again answers the same request and starts none", async () => {
  lists({});
  const { workspaceId } = await workspace();
  const personId = await personAt(workspaceId, "through-host");
  const request = () =>
    inRun(workspaceId, () =>
      enrichment.requestLookup({ personId, requestKey: "panel-click-1", trigger: "request" }),
    );
  const taskQueue = `test-${randomUUID()}`;
  const enrichmentOnly = moduleLoaders.filter(({ name }) => name === "enrichment");
  const options = { taskQueue, healthPort: 0, schedules: "off", alerts: "" } as const;
  const host = await start({ ...options, modules: enrichmentOnly, client: app, log });
  try {
    const first = await request();
    const again = await request();
    assert.equal(again.requestId, first.requestId);
    const handle = env.client.workflow.getHandle(
      `enrichment.lookup:${workspaceId}:${first.requestId}:1`,
    );
    await until(async () => {
      const described = await handle.describe().catch(() => undefined);
      return described?.status.name === "COMPLETED" ? described : undefined;
    });
    assert.deepEqual(await handle.result(), { status: "found" });
  } finally {
    await host.close();
    await env.client.schedule
      .getHandle("enrichment.tick")
      .delete()
      .catch(() => undefined);
  }
  const requested = (await eventsOf(workspaceId)).filter(
    ([name]) => name === "enrichment.lookup_requested",
  );
  assert.equal(requested.length, 1);
  assert.equal(await app.enrichmentRequest.count({ where: { personId } }), 1);
  assert.equal(finder.recordedCalls.length, 1);
});

test("a request key is its person's: the same key for another person of the workspace, reused after the host's 24 hours, is refused enrichment_input_invalid, and the first person's request, left waiting, is neither answered nor queued again; the first person's own key again still queues it as attempt 2", async () => {
  lists({});
  const { workspaceId } = await workspace();
  const first = await personAt(workspaceId, "key-first", { lastName: "First" });
  const second = await personAt(workspaceId, "key-second", { lastName: "Second" });
  const ask = (personId: string) =>
    inRun(workspaceId, () =>
      enrichment.requestLookup({ personId, requestKey: "panel-key-reused", trigger: "request" }),
    );
  const asked = await ask(first);
  // Left waiting, as a lookup short of credits ends: a key given again would queue it anew.
  await app.enrichmentRequest.update({
    where: { id: asked.requestId },
    data: { status: "waiting_budget", reason: "insufficient_credits", finishedAt: NOW },
  });
  const before = (await eventsOf(workspaceId)).length;
  await assert.rejects(ask(second), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "enrichment_input_invalid");
    return true;
  });
  const kept = await app.enrichmentRequest.findUniqueOrThrow({ where: { id: asked.requestId } });
  assert.deepEqual([kept.personId, kept.status, kept.attempt], [first, "waiting_budget", 1]);
  assert.equal(await app.enrichmentRequest.count({ where: { personId: second } }), 0);
  assert.equal((await eventsOf(workspaceId)).length, before);

  const again = await ask(first);
  assert.deepEqual([again.requestId, again.status], [asked.requestId, "queued"]);
  const queued = await app.enrichmentRequest.findUniqueOrThrow({ where: { id: asked.requestId } });
  assert.equal(queued.attempt, 2);
});

const CONTACT = "linkedin-contact-info";
const MEMBER = "fake-member-contact";
/** A LinkedIn account of the workspace, connected on the fake, that invited the person: accepted or not. */
async function connectedTo(workspaceId: string, personId: string, accepted = true) {
  const ref = `fake-account-${randomUUID()}`;
  linkedinFake.emitWebhook("account.connected", ref);
  const { id } = await linkedinTesting.createConnectedAccount(workspaceId, {
    providerAccountRef: ref,
  });
  await linkedinTesting.createOutreach(workspaceId, {
    senderAccountId: id,
    personId,
    providerMemberRef: MEMBER,
    ...(accepted && { acceptedAt: days(-30) }),
  });
  return { id, ref };
}
const contactCalls = () =>
  linkedinFake.recordedCalls.filter(({ method }) => method === "getContactEmails");
const profileReads = (workspaceId: string) =>
  app.senderActionLog
    .findMany({ where: { workspaceId, kind: "read_profile" }, orderBy: { id: "asc" } })
    .then((rows) => rows.map(({ outcome, objectRef }) => [outcome, objectRef]));

test("linkedin-contact-info on: the addresses a connected lead shows, the company's domain first, one kept on the verifier's valid as work_email with the class linkedin_contact_info and the fake as its provider; one read_profile read naming the person; no address in the history, providers_tried, an event, a log line or the action log", async (t) => {
  lists({ sources: [CONTACT, "email-finder"] });
  linkedinTesting.useContactInfoEnabled(true);
  const { workspaceId } = await workspace();
  const personId = await personAt(workspaceId, "contact-on");
  const account = await connectedTo(workspaceId, personId);
  linkedinFake.seedContactEmails(MEMBER, [GMAIL, WORK.toUpperCase()]);
  const workflowId = `enrichment_lookup-${randomUUID()}`;
  const { requestId, request } = await lookup(workspaceId, personId, { workflowId });
  t.diagnostic(`history: ${workflowId}`);
  assert.equal(request.status, "found");
  assert.deepEqual(tried(request.providersTried), [
    step(CONTACT, "find", "found"),
    step(CONTACT, "candidate", "kept"),
    step(CONTACT, "candidate", "kept"),
    step("email-verifier/fake", "verify", "valid"),
  ]);
  assert.deepEqual(addresses(verifier.recordedCalls), [WORK]);
  assert.equal(finder.recordedCalls.length, 0, "the finder is not asked");
  assert.deepEqual(
    contactCalls().map(({ input }) => input),
    [{ providerAccountRef: account.ref, memberRef: MEMBER }],
  );
  const [point] = await pointsOf(personId);
  assert.deepEqual(
    [point?.value, point?.kind, point?.sourceClass, point?.provider],
    [WORK, "work_email", "linkedin_contact_info", "fake"],
  );
  // What the lead shows is free (gamma-en-100): reserved for the finder after it, then released.
  assert.deepEqual(await usageStatuses(requestId), ["released"]);
  assert.deepEqual(await profileReads(workspaceId), [
    ["reserved", personId],
    ["ok", personId],
  ]);
  holdsNoValue(await historyOf(workflowId), "the history");
  holdsNoValue(JSON.stringify(request.providersTried), "providers_tried");
  holdsNoValue(JSON.stringify(await eventsOf(workspaceId)), "the events");
  holdsNoValue(logs.raw.join("\n"), "the log");
  const log = await app.senderActionLog.findMany({ where: { workspaceId } });
  holdsNoValue(JSON.stringify(log), "the action log");
  await noFiles(workspaceId);
});

test("linkedin-contact-info on: a US lead's gmail.com address, the only one shown, kept on valid as personal_email with the class linkedin_contact_info; a lead the account invited but who never accepted is not_connected, with no call and no read, and the next source asked", async () => {
  lists({ sources: [CONTACT, "email-finder"] });
  linkedinTesting.useContactInfoEnabled(true);
  const { workspaceId } = await workspace();
  const us = await personAt(workspaceId, "contact-personal");
  await connectedTo(workspaceId, us);
  linkedinFake.seedContactEmails(MEMBER, [GMAIL]);
  const personal = await lookup(workspaceId, us);
  assert.equal(personal.request.status, "found");
  assert.deepEqual(addresses(verifier.recordedCalls), [GMAIL]);
  assert.deepEqual(
    (await pointsOf(us)).map(({ value, kind, sourceClass }) => [value, kind, sourceClass]),
    [[GMAIL, "personal_email", "linkedin_contact_info"]],
  );

  const other = await workspace();
  const pending = await personAt(other.workspaceId, "contact-pending");
  await connectedTo(other.workspaceId, pending, false);
  const calls = contactCalls().length;
  const { request } = await lookup(other.workspaceId, pending);
  assert.equal(request.status, "found");
  assert.deepEqual(tried(request.providersTried).slice(0, 2), [
    step(CONTACT, "find", "not_connected"),
    step("email-finder/fake", "find", "found"),
  ]);
  assert.equal(contactCalls().length, calls);
  assert.deepEqual(await profileReads(other.workspaceId), []);
});

test("linkedin-contact-info on: a lead without a LinkedIn profile, known by an email address alone (gamma-rf-050), is not_connected, though the workspace has a connected account, with no call and no read, and the next source asked", async () => {
  lists({ sources: [CONTACT, "email-finder"] });
  linkedinTesting.useContactInfoEnabled(true);
  const { workspaceId } = await workspace();
  const personId = await inRun(workspaceId, async () => {
    const imported = { source: "import", provider: "csv" } as const;
    const profile = { email: "noor.h@blueharbor.example", firstName: "Noor", lastName: "Haddad" };
    const { person } = await contacts.upsertPersonFromSource({ ...imported, profile });
    assert.equal(person.linkedinUrl, null);
    const { company } = await contacts.upsertCompany({ ...imported, company: BLUE });
    await contacts.linkPersonToCompany({ personId: person.id, companyId: company.id });
    return person.id;
  });
  const ref = `fake-account-${randomUUID()}`;
  linkedinFake.emitWebhook("account.connected", ref);
  await linkedinTesting.createConnectedAccount(workspaceId, { providerAccountRef: ref });
  const calls = contactCalls().length;
  const { request } = await lookup(workspaceId, personId);
  assert.equal(request.status, "found");
  assert.deepEqual(tried(request.providersTried).slice(0, 2), [
    step(CONTACT, "find", "not_connected"),
    step("email-finder/fake", "find", "found"),
  ]);
  assert.equal(contactCalls().length, calls);
  assert.deepEqual(await profileReads(workspaceId), []);
});

test("linkedin-contact-info off, the default: listed, it is skipped as disabled with no read reserved and no call, and the next source asked; switched off after an address was found, workEmailOf and addressOf still answer it, nothing is deleted, and a later lookup uses it with no call", async () => {
  lists({ sources: [CONTACT, "email-finder"] });
  const { workspaceId } = await workspace();
  const off = await personAt(workspaceId, "contact-off");
  await connectedTo(workspaceId, off);
  linkedinFake.seedContactEmails(MEMBER, [GMAIL]);
  const skipped = await lookup(workspaceId, off);
  assert.equal(skipped.request.status, "found");
  assert.deepEqual(tried(skipped.request.providersTried).slice(0, 2), [
    step(CONTACT, "find", "disabled"),
    step("email-finder/fake", "find", "found"),
  ]);
  assert.equal(contactCalls().length, 0);
  assert.deepEqual(await profileReads(workspaceId), []);

  linkedinTesting.useContactInfoEnabled(true);
  const earlier = await personAt(workspaceId, "contact-earlier", { lastName: "Earlier" });
  await connectedTo(workspaceId, earlier);
  const found = await lookup(workspaceId, earlier);
  const contactPointId = found.request.contactPointId ?? assert.fail("no address");
  assert.deepEqual(
    (await pointsOf(earlier)).map(({ value, sourceClass }) => [value, sourceClass]),
    [[GMAIL, "linkedin_contact_info"]],
  );
  linkedinTesting.useContactInfoEnabled(false);
  assert.deepEqual(
    await inRun(workspaceId, async () => [
      await enrichment.addressOf(contactPointId),
      (await enrichment.workEmailOf(earlier))?.contactPointId,
    ]),
    [GMAIL, contactPointId],
  );
  const calls = contactCalls().length;
  const again = await lookup(workspaceId, earlier);
  assert.deepEqual([again.request.status, again.request.contactPointId], ["found", contactPointId]);
  assert.equal(contactCalls().length, calls);
  assert.equal((await pointsOf(earlier)).length, 1);
});

// gamma-en-085: the free sources in their production order, linkedin-contact-info aside (off by
// default): reply,website,pattern,email-finder.
const FREE = ["reply", "website", "pattern", "email-finder"];
const ACME = { name: "Acme Robotics", domain: "acme.example" };
/** What no history, providers_tried, event, log line or other person's row may hold. */
const SITE_VALUES = ["acme", "jane", "doe", "john", "smith", "lena", "park", "omar"];
/** The person's message in a thread of their own, as inbox's store keeps it. */
async function wrote(workspaceId: string, personId: string, body: string, direction?: "out") {
  const threadId = await createThread({ workspaceId, personId });
  await createMessage({ workspaceId, threadId, personId, body, ...(direction && { direction }) });
}
/** The domain's patterns (gamma-rf-030): each one's count and whether the site showed it. */
const domainPatterns = async (domain: string) =>
  Object.fromEntries(
    (await app.emailDomainPattern.findMany({ where: { domain } })).map(
      ({ pattern, verifiedCount, siteSeenAt }) => [pattern, [verifiedCount, siteSeenAt !== null]],
    ),
  );

test("the lead's reply first (reply,website,pattern,email-finder): of a message holding the lead's address and a colleague's, only the lead's, kept on valid with class lead_reply and no site read or finder asked; a US lead's gmail.com address kept as personal_email; the workspace's own message to the lead never read", async () => {
  lists({ sources: FREE });
  const { workspaceId } = await workspace();
  const personId = await personAt(workspaceId, "reply-work");
  await wrote(workspaceId, personId, `Reach my team at sales@ourco.example`, "out");
  await wrote(
    workspaceId,
    personId,
    `Copying Sam: sam.lee@${BLUE.domain}. Mine is ${WORK.toUpperCase()}`,
  );
  const workflowId = `enrichment_lookup-${randomUUID()}`;
  const { request } = await lookup(workspaceId, personId, { workflowId });
  assert.deepEqual([request.status, request.reason], ["found", null]);
  assert.deepEqual(tried(request.providersTried), [
    step("reply", "find", "found"),
    step("reply", "candidate", "kept"),
    step("email-verifier/fake", "verify", "valid"),
  ]);
  const [point, ...more] = await pointsOf(personId);
  assert.deepEqual(more, []);
  assert.deepEqual(
    [point?.value, point?.kind, point?.sourceClass, point?.provider],
    [WORK, "work_email", "lead_reply", "reply"],
  );
  assert.deepEqual(addresses(verifier.recordedCalls), [WORK]);
  assert.deepEqual([finder.recordedCalls.length, served], [0, []]);
  holdsNoValue(await historyOf(workflowId), "the lookup's history");
  holdsNoValue(JSON.stringify(request.providersTried), "providers_tried");
  holdsNoValue(logs.raw.join("\n"), "the log");
  await noFiles(workspaceId);

  verifier.reset();
  const us = await personAt(workspaceId, "reply-gmail", { lastName: "Reed" });
  await wrote(workspaceId, us, "Use my personal one: janed1987@gmail.com");
  const personal = await lookup(workspaceId, us);
  assert.equal(personal.request.status, "found");
  assert.deepEqual(
    (await pointsOf(us)).map(({ value, kind, sourceClass }) => [value, kind, sourceClass]),
    [["janed1987@gmail.com", "personal_email", "lead_reply"]],
  );
  assert.deepEqual(addresses(verifier.recordedCalls), ["janed1987@gmail.com"]);
});

test("the site, then the pattern: a team page's \"John Smith, john.smith@acme.example\" gives acme.example {first}.{last}, and Jane Doe there gets one guess, jane.doe@acme.example, kept with class pattern and the pattern written verified; Lena Park's own address on the page is a website candidate; the next lead, Omar Ali, needs one verification; role and other people's addresses never stored, logged or passed on", async () => {
  lists({ sources: FREE });
  const { workspaceId } = await workspace();
  const jane = await personAt(workspaceId, "site-jane", {
    company: ACME,
    firstName: "Jane",
    lastName: "Doe",
  });
  const workflowId = `enrichment_lookup-${randomUUID()}`;
  const { requestId, request } = await lookup(workspaceId, jane, { workflowId });
  assert.deepEqual([request.status, request.reason], ["found", null]);
  assert.deepEqual(tried(request.providersTried), [
    step("reply", "find", "not_found"),
    step("website", "find", "pattern_found"),
    step("pattern", "find", "found"),
    step("pattern", "candidate", "kept"),
    step("email-verifier/fake", "verify", "valid"),
  ]);
  assert.deepEqual(served, ["/robots.txt", "/acme/", "/acme/team"]);
  assert.deepEqual(addresses(verifier.recordedCalls), ["jane.doe@acme.example"]);
  assert.equal(finder.recordedCalls.length, 0);
  assert.deepEqual(
    (await pointsOf(jane)).map(({ value, kind, sourceClass }) => [value, kind, sourceClass]),
    [["jane.doe@acme.example", "work_email", "pattern"]],
  );
  assert.deepEqual(await domainPatterns(ACME.domain), { "{first}.{last}": [1, true] });
  assert.deepEqual(await usageStatuses(requestId), ["committed"]);
  // Nobody else's address: no row, no file, no history, providers_tried, event or log line.
  const kept = JSON.stringify([
    await app.contactPoint.findMany({}),
    await app.enrichmentCacheEntry.findMany({}),
    await app.emailDomainStatus.findMany({}),
    await app.emailDomainPattern.findMany({}),
  ]);
  for (const other of ["john", "smith", "lena", "info@"]) {
    assert.ok(!kept.includes(other), `a row holds "${other}"`);
  }
  for (const [text, what] of [
    [await historyOf(workflowId), "the lookup's history"],
    [JSON.stringify(request.providersTried), "providers_tried"],
    [JSON.stringify(await eventsOf(workspaceId)), "the events"],
    [logs.raw.join("\n"), "the log"],
  ] as const) {
    for (const value of SITE_VALUES) assert.ok(!text.includes(value), `${what} holds "${value}"`);
  }
  await noFiles(workspaceId);

  verifier.reset();
  const lena = await personAt(workspaceId, "site-lena", {
    company: ACME,
    firstName: "Lena",
    lastName: "Park",
  });
  const own = await lookup(workspaceId, lena);
  assert.equal(own.request.status, "found");
  assert.deepEqual(tried(own.request.providersTried).slice(1, 3), [
    step("website", "find", "found"),
    step("website", "candidate", "kept"),
  ]);
  assert.deepEqual(
    (await pointsOf(lena)).map(({ value, sourceClass, provider }) => [
      value,
      sourceClass,
      provider,
    ]),
    [["lena.park@acme.example", "website", "website"]],
  );

  lists({ sources: ["pattern", "email-finder"] });
  verifier.reset();
  const omar = await personAt(workspaceId, "site-omar", {
    company: ACME,
    firstName: "Omar",
    lastName: "Ali",
  });
  const next = await lookup(workspaceId, omar);
  assert.equal(next.request.status, "found");
  assert.deepEqual(addresses(verifier.recordedCalls), ["omar.ali@acme.example"]);
});

test("without a pattern, guesses follow the order and stop at the first valid, writing the domain's pattern verified; at a catch_all, after which the domain gets no guess and no verifier call; and at ENRICHMENT_EMAIL_MAX_CANDIDATES (3)", async () => {
  lists({ sources: ["pattern"] });
  const { workspaceId } = await workspace();
  const at = (name: string, domain: string, lastName = "Haddad") =>
    personAt(workspaceId, `guess-${name}`, { company: { name, domain }, lastName });

  const plain = await at("Plain", "plain.example");
  verifier.verdictFor("noor.haddad@plain.example", "invalid");
  verifier.verdictFor("noor@plain.example", "unknown");
  const first = await lookup(workspaceId, plain);
  assert.deepEqual([first.request.status, first.request.reason], ["found", null]);
  assert.deepEqual(addresses(verifier.recordedCalls), [
    "noor.haddad@plain.example",
    "noor@plain.example",
    "nhaddad@plain.example",
  ]);
  assert.deepEqual(await domainPatterns("plain.example"), { "{f}{last}": [1, false] });

  verifier.reset();
  const loose = await at("Loose", "loose.example");
  verifier.verdictFor("noor.haddad@loose.example", "catch_all");
  const caught = await lookup(workspaceId, loose);
  assert.deepEqual([caught.request.status, caught.request.reason], ["not_found", "catch_all"]);
  assert.deepEqual(addresses(verifier.recordedCalls), ["noor.haddad@loose.example"]);
  verifier.reset();
  const later = await at("Loose", "loose.example", "Other");
  const none = await lookup(workspaceId, later);
  assert.deepEqual([none.request.status, none.request.reason], ["not_found", "catch_all"]);
  assert.deepEqual(verifier.recordedCalls, []);
  assert.deepEqual(await usageOf(none.requestId), []);

  verifier.reset();
  const tight = await at("Tight", "tight.example");
  for (const local of ["noor.haddad", "noor", "nhaddad"]) {
    verifier.verdictFor(`${local}@tight.example`, "invalid");
  }
  const bounded = await lookup(workspaceId, tight);
  assert.deepEqual([bounded.request.status, bounded.request.reason], ["not_found", "not_verified"]);
  assert.equal(verifier.recordedCalls.length, 3);
  assert.deepEqual(await domainPatterns("tight.example"), {});
});

test("a lookup at a domain with two patterns (gamma-rf-030): {first}.{last} verified 5 times and {f}{last} once, Jane Doe's guesses in that order and no third, the second kept with class pattern and counted; Omar Ali's two failing guesses end not_verified with no third; a re-verification, and the same address kept again for Jane, count nothing", async () => {
  lists({ sources: ["pattern"] });
  const { workspaceId } = await workspace();
  const TWO = { name: "Twofold", domain: "twofold.example" };
  await app.emailDomainPattern.createMany({
    data: [
      {
        domain: TWO.domain,
        pattern: "{first}.{last}",
        verifiedCount: 5,
        lastVerifiedAt: days(-30),
      },
      { domain: TWO.domain, pattern: "{f}{last}", verifiedCount: 1, lastVerifiedAt: days(-10) },
      { domain: TWO.domain, pattern: "{first}", siteSeenAt: days(-1) },
    ],
  });
  const at = (slug: string, firstName: string, lastName: string) =>
    personAt(workspaceId, slug, { company: TWO, firstName, lastName });
  const counted = { "{first}.{last}": [5, false], "{f}{last}": [2, false], "{first}": [0, true] };

  const jane = await at("two-jane", "Jane", "Doe");
  verifier.verdictFor("jane.doe@twofold.example", "invalid");
  const found = await lookup(workspaceId, jane);
  assert.deepEqual([found.request.status, found.request.reason], ["found", null]);
  assert.deepEqual(addresses(verifier.recordedCalls), [
    "jane.doe@twofold.example",
    "jdoe@twofold.example",
  ]);
  assert.deepEqual(
    (await pointsOf(jane)).map(({ value, sourceClass }) => [value, sourceClass]),
    [["jdoe@twofold.example", "pattern"]],
  );
  assert.deepEqual(await domainPatterns(TWO.domain), counted);

  verifier.reset();
  const omar = await at("two-omar", "Omar", "Ali");
  verifier.verdictFor("omar.ali@twofold.example", "invalid");
  verifier.verdictFor("oali@twofold.example", "invalid");
  const failed = await lookup(workspaceId, omar);
  assert.deepEqual([failed.request.status, failed.request.reason], ["not_found", "not_verified"]);
  assert.deepEqual(addresses(verifier.recordedCalls), [
    "omar.ali@twofold.example",
    "oali@twofold.example",
  ]);

  verifier.reset();
  const reverified = await lookup(workspaceId, jane, { reverify: true });
  assert.equal(reverified.request.status, "found");
  assert.deepEqual(addresses(verifier.recordedCalls), ["jdoe@twofold.example"]);
  assert.deepEqual(await domainPatterns(TWO.domain), counted);

  // 130 days on, past the address's and the cache's 120: Jane's guesses again, her own kept again.
  clock = days(130);
  verifier.reset();
  verifier.verdictFor("jane.doe@twofold.example", "invalid");
  const renewed = await lookup(workspaceId, jane);
  assert.equal(renewed.request.status, "found");
  assert.equal(verifier.recordedCalls.length, 2);
  const [point, ...more] = await pointsOf(jane);
  assert.deepEqual([point?.value, point?.verifiedAt, more], ["jdoe@twofold.example", clock, []]);
  assert.deepEqual(await domainPatterns(TWO.domain), counted);
});

// gamma-en-100: the owner's decisions of 2026-11-14.
/** The domain recorded catch-all for every workspace, for 30 days from NOW. */
async function recordCatchAll(domain: string): Promise<void> {
  await app.emailDomainStatus.create({
    data: {
      ...{ id: `eds_test_${domain}`, domain, catchAll: true, provider: "fake" },
      ...{ checkedAt: NOW, expiresAt: days(30) },
    },
  });
}

test("the lead's own sources first (reply,email-finder): with no company domain, the gmail.com address a lead wrote kept on valid as personal_email, nothing reserved and no finder asked; a UK lead's skipped while ENRICHMENT_PERSONAL_EMAIL_EU_UK is off, ending no_domain as before, and kept once it is on; a lead who wrote none ends no_domain", async () => {
  lists({ sources: ["reply", "email-finder"] });
  const { workspaceId } = await workspace();
  const homeless = await personAt(workspaceId, "own-homeless", { company: null });
  await wrote(workspaceId, homeless, `Write to me at ${GMAIL.toUpperCase()}`);
  const workflowId = `enrichment_lookup-${randomUUID()}`;
  const kept = await lookup(workspaceId, homeless, { workflowId });
  assert.deepEqual([kept.request.status, kept.request.reason], ["found", null]);
  assert.deepEqual(tried(kept.request.providersTried), [
    step("reply", "find", "found"),
    step("reply", "candidate", "kept"),
    step("email-verifier/fake", "verify", "valid"),
  ]);
  assert.deepEqual(
    (await pointsOf(homeless)).map(({ value, kind, sourceClass }) => [value, kind, sourceClass]),
    [[GMAIL, "personal_email", "lead_reply"]],
  );
  assert.deepEqual(await usageOf(kept.requestId), []);
  assert.equal(kept.request.creditsCharged.toFixed(), "0");
  assert.deepEqual([finder.recordedCalls.length, addresses(verifier.recordedCalls)], [0, [GMAIL]]);
  holdsNoValue(await historyOf(workflowId), "the history");
  holdsNoValue(JSON.stringify(await eventsOf(workspaceId)), "the events");
  await noFiles(workspaceId);

  verifier.reset();
  const london = { company: null, locationText: "London, United Kingdom", lastName: "Uk" };
  const uk = await personAt(workspaceId, "own-homeless-uk", london);
  await wrote(workspaceId, uk, "Mine: noor.uk@gmail.com");
  const waits = await lookup(workspaceId, uk);
  assert.deepEqual([waits.request.status, waits.request.reason], ["not_found", "no_domain"]);
  assert.deepEqual(tried(waits.request.providersTried), [
    step("reply", "find", "found"),
    step("reply", "candidate", "personal_needs_consent"),
  ]);
  assert.deepEqual(verifier.recordedCalls, []);
  usePersonalEmailEuUk(true);
  const consented = await lookup(workspaceId, uk);
  assert.equal(consented.request.status, "found");
  assert.deepEqual(addresses(verifier.recordedCalls), ["noor.uk@gmail.com"]);
  usePersonalEmailEuUk(undefined);

  const silent = await personAt(workspaceId, "own-homeless-silent", {
    company: null,
    lastName: "Silent",
  });
  const none = await lookup(workspaceId, silent);
  assert.deepEqual([none.request.status, none.request.reason], ["not_found", "no_domain"]);
  assert.deepEqual(tried(none.request.providersTried), [step("reply", "find", "not_found")]);
  assert.deepEqual(await cacheOf(silent), []);
  assert.deepEqual([finder.recordedCalls.length, await usageOf(none.requestId)], [0, []]);
});

test("the lead's own sources first at a company domain recorded catch-all: the work address a lead wrote dropped as catch_all_domain with no verifier call, their gmail.com one kept, nothing reserved and no finder asked; a lead who wrote none ends catch_all as before, with no entry written", async () => {
  lists({ sources: ["reply", "email-finder"] });
  const { workspaceId } = await workspace();
  const LOOSE = { name: "Loose Ends", domain: "loose.example" };
  await recordCatchAll(LOOSE.domain);
  const both = await personAt(workspaceId, "own-catch-all", { company: LOOSE });
  await wrote(workspaceId, both, `Work: noor.haddad@${LOOSE.domain}, home: ${GMAIL}`);
  const kept = await lookup(workspaceId, both);
  assert.deepEqual([kept.request.status, kept.request.reason], ["found", null]);
  assert.deepEqual(tried(kept.request.providersTried), [
    step("reply", "find", "found"),
    step("reply", "candidate", "catch_all_domain"),
    step("reply", "candidate", "kept"),
    step("email-verifier/fake", "verify", "valid"),
  ]);
  assert.deepEqual(
    (await pointsOf(both)).map(({ value, kind }) => [value, kind]),
    [[GMAIL, "personal_email"]],
  );
  assert.deepEqual(addresses(verifier.recordedCalls), [GMAIL]);
  assert.deepEqual([finder.recordedCalls.length, await usageOf(kept.requestId)], [0, []]);

  verifier.reset();
  const silent = await personAt(workspaceId, "own-catch-all-silent", {
    company: LOOSE,
    lastName: "Silent",
  });
  const none = await lookup(workspaceId, silent);
  assert.deepEqual([none.request.status, none.request.reason], ["not_found", "catch_all"]);
  assert.deepEqual(tried(none.request.providersTried), [step("reply", "find", "not_found")]);
  assert.deepEqual(await cacheOf(silent), []);
  assert.deepEqual([finder.recordedCalls.length, verifier.recordedCalls.length], [0, 0]);
  assert.deepEqual(await usageOf(none.requestId), []);
});

test("free when the lead gave it (reply,email-finder): the address a lead wrote kept with its reservation released and nothing charged, a finder's committed as before; a workspace with no credits still gets the address a lead wrote, nothing reserved, and a lead who wrote none waits for credits (waiting_budget), the finder not asked", async () => {
  lists({ sources: ["reply", "email-finder"] });
  const { workspaceId } = await workspace();
  const gave = await personAt(workspaceId, "free-gave");
  await wrote(workspaceId, gave, `Mine is ${WORK}`);
  const given = await lookup(workspaceId, gave);
  assert.equal(given.request.status, "found");
  assert.deepEqual(await usageStatuses(given.requestId), ["released"]);
  assert.equal(given.request.creditsCharged.toFixed(), "0");
  assert.equal(finder.recordedCalls.length, 0);

  const found = await personAt(workspaceId, "free-found", { lastName: "Found" });
  const charged = await lookup(workspaceId, found);
  assert.equal(charged.request.status, "found");
  assert.deepEqual(await usageStatuses(charged.requestId), ["committed"]);
  assert.equal(charged.request.creditsCharged.toFixed(), "1");
  assert.equal(finder.recordedCalls.length, 1);

  const broke = await workspace(0);
  const poor = await personAt(broke.workspaceId, "free-poor", { lastName: "Poor" });
  await wrote(broke.workspaceId, poor, `Use noor.poor@${BLUE.domain}`);
  const free = await lookup(broke.workspaceId, poor);
  assert.deepEqual([free.request.status, free.request.reason], ["found", null]);
  assert.deepEqual(
    (await pointsOf(poor)).map(({ value, sourceClass }) => [value, sourceClass]),
    [[`noor.poor@${BLUE.domain}`, "lead_reply"]],
  );
  assert.deepEqual(await usageOf(free.requestId), []);

  const quiet = await personAt(broke.workspaceId, "free-quiet", { lastName: "Quiet" });
  const waiting = await lookup(broke.workspaceId, quiet);
  assert.deepEqual(
    [waiting.request.status, waiting.request.reason],
    ["waiting_budget", "insufficient_credits"],
  );
  assert.deepEqual(tried(waiting.request.providersTried), [step("reply", "find", "not_found")]);
  assert.deepEqual([finder.recordedCalls.length, await usageOf(waiting.requestId)], [1, []]);
});
