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
// their own workspaces, are the e2e module's too, written with messaging's factory, as is the ICP's
// draft in its own. The agents' links are checked by signals' own source checker, which signals
// registers as it loads (gamma-p5-045).
// Set before anything of the host loads: each config reads its variables once, at import.
import { randomBytes } from "node:crypto";
import type { LinkedinFake } from "@whytide/providers";

const web = `http://127.0.0.1:${process.env.WEB_PORT}`;
process.env.PROVIDER_LINKEDIN = "fake";
// The mailboxes screen connects on the mailbox fake, whose consent lands on the web's callback page.
process.env.PROVIDER_MAILBOX = "fake";
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
/** A Member, no Owner, of the never-contact screen's workspaces alone (contacts-never-contact.spec.ts,
 * contacts-exclusions.spec.ts). */
const NEVER_CONTACT_MEMBER = "e2e-member@example.com";
/** The e2e users' second workspace (core/apps/web/tests/company-screen.spec.ts and
 * onboarding-draft-button.spec.ts). */
const SECOND_WORKSPACE = "wsp_e2e_b";
/** A third, the import screen's: the files port takes a workspace id of letters and digits only. */
const IMPORT_WORKSPACE = "wsp_e2eimport";
/** A fourth, the review panel's leads (core/apps/web/tests/review-panel.spec.ts). */
const REVIEW_WORKSPACE = "wsp_e2e_review";
/** Approve's, where E2E_EMAIL has a connected account (core/apps/web/tests/contacts-approve.spec.ts). */
const APPROVE_WORKSPACE = "wsp_e2e_approve";
/** The enrollment panel's, with a connected account (core/apps/web/tests/campaigns-enrollment-panel.spec.ts). */
const ENROLLMENT_WORKSPACE = "wsp_e2e_enrollment";
/** The imports as sources, an upload's and a post source's (core/apps/web/tests/import-sources.spec.ts). */
const IMPORT_SOURCES_WORKSPACE = "wsp_e2esources";
/** The import of a CSV file of sources (core/apps/web/tests/sources-csv-import.spec.ts). */
const SOURCE_IMPORTS_WORKSPACE = "wsp_e2e_source_imports";

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
const { EVIDENCE_WORKSPACE, FOUND_WORKSPACE, RUN_NOW_WORKSPACE, STATES_WORKSPACE } = signals;
const { seedEvidenceRoute, seedFoundRoute, seedRunsRoute, seedSenders } = signals;
const onboarding = await import("./e2e-onboarding.ts");
const { DOCUMENTS_WORKSPACE, DRAFT_WORKSPACE, GET_STARTED_WORKSPACE } = onboarding;
const { seedDocumentsRoute, seedDraftRoute, seedGetStartedRoute } = onboarding;
const { holdRoute } = await import("./e2e-hold.ts");
const { AUDIENCES_WORKSPACE, resetAudiencesRoute } = await import("./e2e-icp.ts");

/**
 * The rows the tests stand on: the fixture's organization and its workspaces, which a sealed
 * LinkedIn reference names its organization from; the E2E_USERS, Owners of each, as identity's
 * resolver and the shell read the memberships; NEVER_CONTACT_MEMBER, a Member of one; and the
 * sources screen's sender accounts.
 */
async function seed(): Promise<void> {
  const { createDbClient } = await import("@whytide/db");
  const { addMember, addOwner, upsertUser } = await import("@whytide/tenancy");
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
    // onboarding's documents' card on the Company screen: onboarding-documents.spec.ts.
    { id: DOCUMENTS_WORKSPACE, name: "Documents", slug: "e2e-documents" },
    // onboarding's prompt at sign-in on the workspace home: onboarding-get-started.spec.ts.
    { id: GET_STARTED_WORKSPACE, name: "Get started", slug: "e2e-get-started" },
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
    // signals' Companies found screen and the agent's panel: signals-found-companies.spec.ts.
    { id: FOUND_WORKSPACE, name: "Companies found", slug: "e2e-found" },
    // contacts' states and the list's address: contacts-states.spec.ts, contacts-url-state.spec.ts.
    { id: "wsp_e2e_contacts", name: "Contacts", slug: "e2e-contacts" },
    { id: "wsp_e2e_noleads", name: "No leads", slug: "e2e-noleads" },
    { id: "wsp_e2e_url", name: "List address", slug: "e2e-url" },
    // contacts' never-contact screen and one-click blocks: contacts-never-contact.spec.ts.
    { id: "wsp_e2e_never_contact", name: "Blocks", slug: "e2e-never-contact" },
    // contacts' exclusion lists from a CSV on the never-contact screen: contacts-exclusions.spec.ts.
    { id: "wsp_e2e_exclusions", name: "Exclusion lists", slug: "e2e-exclusions" },
    // contacts' Edit on the lead page: lead-fields-edit.spec.ts.
    { id: "wsp_e2e_lead_edit", name: "Lead edit", slug: "e2e-lead-edit" },
    // contacts' Add lead on the Leads screen: lead-manual-create.spec.ts.
    { id: "wsp_e2e_lead_add", name: "Lead add", slug: "e2e-lead-add" },
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
    // contacts' Approve, with the user's connected account and without: contacts-approve.spec.ts.
    { id: APPROVE_WORKSPACE, name: "Approve", slug: "e2e-approve" },
    { id: "wsp_e2e_approve_none", name: "Approve, no account", slug: "e2e-approve-none" },
    // approvals' "Up next", its items seeded by the e2e module: approvals-up-next.spec.ts.
    { id: "wsp_e2e_up_next", name: "Up next", slug: "e2e-up-next" },
    // campaigns' enrollment panel on the lead page: campaigns-enrollment-panel.spec.ts.
    { id: ENROLLMENT_WORKSPACE, name: "Enrollments", slug: "e2e-enrollment" },
    // campaigns' counts page, its account and steps seeded by the e2e module: campaigns-counts.spec.ts.
    { id: "wsp_e2e_counts", name: "Counts", slug: "e2e-counts" },
    // campaigns' list and campaign page, its draft, account and credits readied by the e2e module:
    // campaigns-sequence-editor.spec.ts.
    { id: "wsp_e2e_campaigns", name: "Campaigns", slug: "e2e-campaigns" },
    // linkedin's pause and "Stop everything", and the operator's stops: linkedin-switches.spec.ts.
    { id: "wsp_e2e_switches", name: "Switches", slug: "e2e-switches" },
    // linkedin's teammates' accounts, an Owner's and a Member's view: linkedin-switches.spec.ts.
    { id: "wsp_e2e_teammates", name: "Teammates", slug: "e2e-teammates" },
    // inbox's screen and its labels, its threads seeded by the e2e module: inbox-screen.spec.ts.
    { id: "wsp_e2e_inbox", name: "Inbox", slug: "e2e-inbox" },
    // inbox's reply draft on a thread, its draft ended by the e2e module: inbox-reply-draft.spec.ts.
    { id: "wsp_e2e_reply_draft", name: "Reply draft", slug: "e2e-reply-draft" },
    // linkedin's risk disclosure for sending, its boxes and its Dialog: linkedin-disclosure.spec.ts.
    { id: "wsp_e2e_disclosure", name: "Disclosure", slug: "e2e-disclosure" },
    // linkedin's health card, its states seeded by the e2e module: linkedin-health.spec.ts.
    { id: "wsp_e2e_linkedin_health", name: "Health", slug: "e2e-linkedin-health" },
    // email's mailboxes screen, connected on the mailbox fake: email-connect.spec.ts.
    { id: "wsp_e2e_email", name: "Email", slug: "e2e-email" },
    // icp's draft card, its draft written by the e2e module: icp-draft.spec.ts.
    { id: "wsp_e2e_icp_draft", name: "ICP draft", slug: "e2e-icp-draft" },
    // icp's audiences, all but the default removed by e2e-icp.ts's reset: icp-screen.spec.ts.
    { id: AUDIENCES_WORKSPACE, name: "Audiences", slug: "e2e-audiences" },
    // the imports as sources and each source's leads: import-sources.spec.ts; its id letters and
    // digits only, for the files port.
    { id: IMPORT_SOURCES_WORKSPACE, name: "Import sources", slug: "e2e-import-sources" },
    // signals' import of a CSV file of sources: sources-csv-import.spec.ts.
    { id: SOURCE_IMPORTS_WORKSPACE, name: "Source imports", slug: "e2e-source-imports" },
    // a member's verdict on the lead page: lead-verdict-edit.spec.ts.
    { id: "wsp_e2e_verdicts", name: "Verdicts", slug: "e2e-verdicts" },
    // tenancy's members screen, its members seeded by the e2e module: tenancy-members.spec.ts.
    { id: "wsp_e2e_members", name: "Members", slug: "e2e-members" },
    // identity's Invites screen and Invitations page, its members seeded by the e2e module:
    // identity-invites.spec.ts; the second, where its known user is a member.
    { id: "wsp_e2e_invites", name: "Invites", slug: "e2e-invites" },
    { id: "wsp_e2e_invitations", name: "Invitations", slug: "e2e-invitations" },
    // campaigns' panel on the agent's page, the agent made through playbooks' route and its campaign
    // by the e2e module: campaigns-agent-panel.spec.ts.
    { id: "wsp_e2e_agent_campaign", name: "Agent campaign", slug: "e2e-agent-campaign" },
    // playbooks' agents screens, their sources and accounts seeded by the e2e module:
    // playbooks-agents.spec.ts.
    { id: "wsp_e2e_agents", name: "Agents", slug: "e2e-agents" },
    // the sources screen's agents, its sources and accounts seeded by the e2e module, linked through
    // playbooks' route: sources-screen.spec.ts.
    { id: "wsp_e2e_source_agents", name: "Source agents", slug: "e2e-source-agents" },
    // campaigns' Results page, its campaigns and enrollments seeded by the e2e module:
    // campaigns-results.spec.ts.
    { id: "wsp_e2e_results", name: "Results", slug: "e2e-results" },
    // campaigns' Health page, its accounts and their health events seeded by the e2e module:
    // campaigns-health.spec.ts.
    { id: "wsp_e2e_health", name: "Health", slug: "e2e-health" },
    // enrichment's company panel on the lead page, its runs ended by the e2e module:
    // enrichment-company-panel.spec.ts.
    { id: "wsp_e2e_enrichment", name: "Enrichment", slug: "e2e-enrichment" },
    // enrichment's Email panel on the lead page, its lookups ended by the e2e module:
    // enrichment-email-panel.spec.ts.
    { id: "wsp_e2e_email_panel", name: "Email panel", slug: "e2e-email-panel" },
  ];
  for (const workspace of workspaces) {
    const row = { ...workspace, organizationId: organization.id };
    await db.workspace.upsert({ where: { id: workspace.id }, create: row, update: {} });
  }
  const users = new Map<string, string>();
  for (const email of E2E_USERS) {
    const { id: userId } = await upsertUser({ email });
    users.set(email, userId);
    for (const { id: workspaceId } of workspaces) await addOwner({ userId, workspaceId });
  }
  const { id: memberId } = await upsertUser({ email: NEVER_CONTACT_MEMBER });
  await addMember({ userId: memberId, workspaceId: "wsp_e2e_never_contact", role: "Member" });
  await addMember({ userId: memberId, workspaceId: "wsp_e2e_exclusions", role: "Member" });
  await seedSenders(db, fixture.FIXTURE_WORKSPACE);
  await seedSenders(db, RUN_NOW_WORKSPACE, 3);
  await seedSenders(db, APPROVE_WORKSPACE, 5, users.get(E2E_USERS[0] ?? ""));
  await seedSenders(db, ENROLLMENT_WORKSPACE, 60);
  await seedSenders(db, IMPORT_SOURCES_WORKSPACE, 70);
  await seedSenders(db, SOURCE_IMPORTS_WORKSPACE, 80);
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
    // "Up next": the queue's routes, on the items and drafts the e2e module seeds.
    build("approvals"),
    // The lead page's enrollment panel, the counts and the campaigns' screens: on what the e2e module
    // seeds.
    build("campaigns"),
    // The inbox: its threads, messages and labels, which the e2e module seeds.
    build("inbox"),
    // The mailboxes screen: connect, disconnect and reconnect on the mailbox fake.
    build("email"),
    // The agents' screens: playbooks' routes, on the sources the e2e module seeds.
    build("playbooks"),
    // The lead page's company and Email panels: enrichment's routes, on the runs and lookups the e2e
    // module ends.
    build("enrichment"),
    { name: "e2e", load: () => import("./fixtures/e2e/index.ts") },
  ],
  mount: [
    connect,
    seedRunsRoute(fixture.FIXTURE_WORKSPACE, RUN_NOW_WORKSPACE),
    seedEvidenceRoute(EVIDENCE_WORKSPACE),
    seedFoundRoute(FOUND_WORKSPACE),
    seedDraftRoute(),
    seedDocumentsRoute(),
    seedGetStartedRoute(),
    resetAudiencesRoute(),
    holdRoute(),
  ],
});
url = api.url;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void api.close());
