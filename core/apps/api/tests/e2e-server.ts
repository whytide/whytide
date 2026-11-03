// `pnpm -F api serve:e2e` (README "Commands"): the api the web's Playwright tests run against,
// under APP_ENV=test so that the fake adapters' test routes exist: tenancy and identity, whose
// resolver reads the memberships, the routes of the api's fixture module (not its resolver), the
// modules whose screens the tests open, and the Better Auth adapter, which identity's flows use
// through the screens with the link from Mailpit, beside the fake, whose test route signs the
// host's tests in. Before it listens, the fixture's workspace, wsp_fixture_a, a second one,
// SECOND_WORKSPACE, for a screen's two-workspace check, and IMPORT_WORKSPACE, the import screen's,
// are made with the E2E_USERS their Owners; the flows invite emails of their own as `pnpm invite`
// does. The web at WEB_PORT is APP_PUBLIC_ORIGIN, the origin of its writes, of the sign-in links
// (AUTH_BASE_URL: it sends /api/auth/* here) and of the LinkedIn fake's hosted links, which the web
// rewrites to the fake's connect route mounted here; a visit posts its webhook to this api. The
// sources screen's sender accounts and runs, and the evidence panel's leads, sources and events in
// EVIDENCE_WORKSPACE, made as the others, are seeded by e2e-signals.ts; the lead list's leads and
// credits, and the lead page's snapshots (read through qualification's route), by the test-only
// module of fixtures/e2e/, which also seeds the review panel's in REVIEW_WORKSPACE, made as the
// others; the draft review's record, in DRAFT_WORKSPACE, made as the others, by e2e-onboarding.ts;
// and e2e-hold.ts slows or fails a read that a spec's cookie names. The draft panel's drafts, in
// their own workspaces, are the e2e module's too, written with messaging's factory.
// Set before anything of the host loads: each config reads its variables once, at import.
import { randomBytes } from "node:crypto";
import type { LinkedinFake } from "@whytide/providers";

const web = `http://127.0.0.1:${process.env.WEB_PORT}`;
process.env.PROVIDER_LINKEDIN = "fake";
process.env.APP_PUBLIC_ORIGIN ||= web;
process.env.AUTH_BASE_URL = web;
// Each flow signs in through three /api/auth/* and /v1/sign-in calls: more than 20 a minute.
process.env.RATE_LIMIT_AUTH_PER_IP_PER_MIN = "600";
// The e2e api seals LinkedIn references and never opens one: a key of its own, kept in memory.
process.env.APP_MASTER_KEY ||= randomBytes(32).toString("base64");
// The link core/apps/web/tests/tenancy-feedback-link.spec.ts expects, whatever .env.local says.
process.env.FEEDBACK_URL = "https://feedback.example.com/alpha";

/**
 * The emails the host's tests sign in with, each its own user, so that specs running at once never
 * share a LinkedIn account; core/apps/web/tests/sign-in.ts signs them in.
 */
const E2E_USERS = [
  "e2e@example.com",
  "e2e-usage@example.com",
  "e2e-states@example.com",
  "e2e-read-cap@example.com",
];
/** The e2e users' second workspace (core/apps/web/tests/company-screen.spec.ts and
 * onboarding-draft-button.spec.ts). */
const SECOND_WORKSPACE = "wsp_e2e_b";
/** A third, the import screen's: the files port takes a workspace id of letters and digits only. */
const IMPORT_WORKSPACE = "wsp_e2eimport";
/** A fourth, the review panel's leads (core/apps/web/tests/review-panel.spec.ts). */
const REVIEW_WORKSPACE = "wsp_e2e_review";

const { authPort, getAdapter, linkedinPort } = await import("@whytide/providers");
const betterAuth = await getAdapter(authPort, "better-auth");
const fake = await getAdapter(authPort, "fake");
const auth: typeof betterAuth = {
  ...betterAuth,
  configure: async (hooks) => {
    await fake.configure(hooks);
    await betterAuth.configure(hooks);
  },
  mountHandler: async (app) => {
    await fake.mountHandler(app);
    await betterAuth.mountHandler(app);
  },
  resolvePrincipal: async (req) =>
    (await betterAuth.resolvePrincipal(req)) ?? fake.resolvePrincipal(req),
};
const linkedinFake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
let url = "";
const connect = linkedinFake.connectOnVisit(({ headers, rawBody }) =>
  fetch(`${url}/v1/linkedin/webhooks/fake`, {
    method: "POST",
    headers: headers as Record<string, string>,
    body: rawBody,
  }),
);
// An import's run hashes every person it writes, and a slice's HASH_SALT is empty: a fixed test
// salt, as the api's own tests set it (core/apps/web/tests/import-screen.spec.ts).
const { useHashSalt } = await import("@whytide/contacts/testing");
useHashSalt("test-salt-".repeat(4));
const { start } = await import("../src/start.ts");
const { workspaceResolver: _, ...fixture } = await import("./fixtures/module/index.ts");
const signals = await import("./e2e-signals.ts");
const { EVIDENCE_WORKSPACE, RUN_NOW_WORKSPACE, STATES_WORKSPACE, seedEvidenceRoute } = signals;
const { seedRunsRoute, seedSenders } = signals;
const { DRAFT_WORKSPACE, seedDraftRoute } = await import("./e2e-onboarding.ts");
const { holdRoute } = await import("./e2e-hold.ts");

/**
 * The rows the tests stand on: the fixture's organization and its workspaces, which a sealed
 * LinkedIn reference names its organization from; the E2E_USERS, Owners of each, as identity's
 * resolver and the shell read the memberships; and the sources screen's sender accounts.
 */
async function seed(): Promise<void> {
  const { createDbClient } = await import("@whytide/db");
  const { addOwner, upsertUser } = await import("@whytide/tenancy");
  const db = createDbClient("app");
  const organization = { id: "org_fixture_a", name: "Fixture", slug: "fixture-a" };
  await db.organization.upsert({
    where: { id: organization.id },
    create: organization,
    update: {},
  });
  const workspaces = [
    { id: fixture.FIXTURE_WORKSPACE, name: "Fixture", slug: "fixture-a" },
    { id: SECOND_WORKSPACE, name: "Second", slug: "e2e-b" },
    { id: IMPORT_WORKSPACE, name: "Import", slug: "e2eimport" },
    { id: DRAFT_WORKSPACE, name: "Draft review", slug: "e2e-c" },
    { id: REVIEW_WORKSPACE, name: "Review", slug: "e2e-review" },
    // qualification's panel, one per spec: qualification-states.spec.ts, rescore-action.spec.ts.
    { id: "wsp_e2e_qual", name: "Qualification", slug: "e2e-qual" },
    { id: "wsp_e2e_rescore", name: "Re-score", slug: "e2e-rescore" },
    // contacts' Export button: export-button.spec.ts.
    { id: "wsp_e2e_export", name: "Export", slug: "e2e-export" },
    // signals' evidence panel on the lead page: evidence-panel.spec.ts.
    { id: EVIDENCE_WORKSPACE, name: "Evidence", slug: "e2e-evidence" },
    // signals' screen states and Run now: signals-states.spec.ts, signals-run-now.spec.ts.
    { id: STATES_WORKSPACE, name: "Signals", slug: "e2e-signals" },
    { id: RUN_NOW_WORKSPACE, name: "Run now", slug: "e2e-run-now" },
    // contacts' states and the list's address: contacts-states.spec.ts, contacts-url-state.spec.ts.
    { id: "wsp_e2e_contacts", name: "Contacts", slug: "e2e-contacts" },
    { id: "wsp_e2e_noleads", name: "No leads", slug: "e2e-noleads" },
    { id: "wsp_e2e_url", name: "List address", slug: "e2e-url" },
    // messaging's draft panel on the lead page: messaging-draft-panel.spec.ts, and its states and
    // gaps, messaging-states.spec.ts.
    { id: "wsp_e2e_drafts", name: "Drafts", slug: "e2e-drafts" },
    { id: "wsp_e2e_messaging", name: "Messaging", slug: "e2e-messaging" },
    // credits' screen and the lead page's cost line, and the screen with nothing spent:
    // credits-screen.spec.ts.
    { id: "wsp_e2e_costs", name: "Costs", slug: "e2e-costs" },
    { id: "wsp_e2e_nocosts", name: "No costs", slug: "e2e-nocosts" },
    // every screen at a phone's width: phone-width.spec.ts.
    { id: "wsp_e2e_phone", name: "Phone", slug: "e2e-phone" },
  ];
  for (const workspace of workspaces) {
    const row = { ...workspace, organizationId: organization.id };
    await db.workspace.upsert({ where: { id: workspace.id }, create: row, update: {} });
  }
  for (const email of E2E_USERS) {
    const { id: userId } = await upsertUser({ email });
    for (const { id: workspaceId } of workspaces) await addOwner({ userId, workspaceId });
  }
  await seedSenders(db, fixture.FIXTURE_WORKSPACE);
  await seedSenders(db, RUN_NOW_WORKSPACE, 3);
  await db.$disconnect();
}

/** A module by its build's path, as src/modules.generated.ts: the api lists no screen's module. */
const build = (name: string) => ({
  name,
  load: () => import(new URL(`../../../../modules/${name}/dist/index.js`, import.meta.url).href),
});
const api = await start({
  auth,
  modules: [
    { name: "tenancy", load: () => import("@whytide/tenancy") },
    build("identity"),
    { name: "fixture", load: async () => ({ ...fixture, onStart: seed }) },
    ...["icp", "onboarding", "linkedin", "signals"].map(build),
    // The import screen's: discovery's run writes through contacts, whose lead list the spec reads.
    { name: "contacts", load: () => import("@whytide/contacts") },
    build("discovery"),
    // The lead page's snapshot read.
    build("qualification"),
    // The header's balance, and the reserve and commit of the lead list's test-only spend.
    build("credits"),
    // The lead page's draft panel: the drafts the e2e module seeds and writes in the worker's stead.
    build("messaging"),
    { name: "e2e", load: () => import("./fixtures/e2e/index.ts") },
  ],
  mount: [
    connect,
    seedRunsRoute(fixture.FIXTURE_WORKSPACE, RUN_NOW_WORKSPACE),
    seedEvidenceRoute(EVIDENCE_WORKSPACE),
    seedDraftRoute(),
    holdRoute(),
  ],
});
url = api.url;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void api.close());
