// messaging's dossier route end to end (alpha-p9-010; core/modules/messaging/README.md "Route"): the
// host started with identity and messaging, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP to a Member; the lead and its company written by contacts'
// commands, the Company Knowledge row as onboarding's save leaves it, the events by signals' test
// factory. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createLeadForPerson,
  linkPersonToCompany,
  upsertCompany,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, newId, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// messaging and signals by their builds' paths, as src/modules.generated.ts loads them: messaging
// reads onboarding, whose screen depends on the web, which depends on the api, so a dev dependency
// would close a cycle (onboarding-company-knowledge.test.ts).
const messaging = new URL("../../../../modules/messaging/dist/", import.meta.url);
const signals = new URL("../../../../modules/signals/dist/", import.meta.url);
type MessagingTesting = typeof import("../../../modules/messaging/dist/testing/index.js");
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
const { useMessagingClient }: MessagingTesting = await import(
  new URL("testing/index.js", messaging).href
);
const { createSignalEvent }: SignalsTesting = await import(
  new URL("testing/index.js", signals).href
);

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useMessagingClient(asRole("app"));
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
      { name: "messaging", load: () => import(new URL("index.js", messaging).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

const PROOF = "Northwind booked 40% more meetings in a quarter.";

/** In the tenant's workspace: a person, with `lead` its company, its lead and Company Knowledge. */
const seed = ({ workspace }: TestTenant, slug: string, lead: boolean) =>
  withTenant(
    { workspaceId: workspace.id, principal: servicePrincipal("messaging_test") },
    async (tx) => {
      const profile = {
        linkedinUrl: `https://linkedin.com/in/${slug}`,
        firstName: "Ines",
        lastName: "Duarte",
        headline: "Data at Acme",
        title: "Head of Data",
        locationText: "Lisbon, Portugal",
      };
      const { person } = await upsertPersonFromSource({
        source: "linkedin",
        provider: null,
        profile,
      });
      if (!lead) return person.id;
      const { company } = await upsertCompany({
        source: "linkedin",
        provider: null,
        company: { name: "Acme", linkedinUrl: "https://linkedin.com/company/acme", country: "PT" },
      });
      await linkPersonToCompany({ personId: person.id, companyId: company.id });
      await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sev_1" } });
      const knowledge = { oneLiner: "Warm leads.", products: ["Signal Radar"], painPoints: [] };
      const proofPoints = [{ text: PROOF }];
      await tx.companyKnowledge.create({
        data: { ...knowledge, proofPoints, id: newId("ck"), workspaceId: workspace.id },
      });
      return person.id;
    },
    { client: asRole("app") },
  );

/** GET …/messaging/leads/{personId}/dossier of the workspace, signed in as the user. */
async function dossierOf(workspaceId: string, personId: string, userId: string) {
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const path = `/v1/workspaces/${workspaceId}/messaging/leads/${personId}/dossier`;
  const res = await fetch(new URL(path, api.url), { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET …/messaging/leads/{personId}/dossier answers a Member the lead's dossier, every value a fact, newest event first; 404 dossier_lead_not_found for a person without a lead and for another workspace's", async () => {
  const [a, b] = await createTwoWorkspaces();
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: a.workspace.id, role: "Member" });
  const ours = await seed(a, "ines", true);
  const unled = await seed(a, "no-lead", false);
  const theirs = await seed(b, "ines", true);
  const at = (day: number) => new Date(`2026-10-0${day}T09:00:00.000Z`);
  const workspaceId = a.workspace.id;
  const older = await createSignalEvent({ workspaceId, personId: ours, occurredAt: at(1) });
  const comment = "Exactly our problem.";
  const newer = await createSignalEvent({
    workspaceId,
    personId: ours,
    occurredAt: at(2),
    commentText: comment,
  });

  const { status, body } = await dossierOf(workspaceId, ours, member.id);
  assert.equal(status, 200);
  const { sender, offer, lead, company, whyNow, facts, dossierHash } = body;
  assert.deepEqual(
    { sender, offer, lead, company, whyNow },
    {
      sender: { name: member.displayName },
      offer: {
        oneLiner: "Warm leads.",
        products: ["Signal Radar"],
        painPoints: [],
        proofPoints: [PROOF],
      },
      lead: {
        firstName: "Ines",
        headline: "Data at Acme",
        title: "Head of Data",
        location: "Lisbon, Portugal",
      },
      company: { name: "Acme", industry: null, sizeRange: null, country: "Portugal" },
      whyNow: [
        {
          ...{ postUrl: newer.evidence?.url, excerpt: comment, comment, reaction: "comment" },
          at: at(2).toISOString(),
        },
        {
          postUrl: older.evidence?.url,
          excerpt: null,
          comment: null,
          reaction: "like",
          at: at(1).toISOString(),
        },
      ],
    },
  );
  const listed = facts as { id: string; kind: string; value: string; sourceRef: string }[];
  assert.deepEqual(
    listed.map(({ id }) => id),
    listed.map((_, index) => `f_${index + 1}`),
  );
  const values = [member.displayName, "Warm leads.", "Signal Radar", PROOF];
  const person = ["Ines", "Data at Acme", "Head of Data", "Lisbon, Portugal", "Acme", "Portugal"];
  const events = [newer, older].flatMap(({ evidence }) =>
    evidence?.commentText
      ? [evidence.url, comment, comment, "comment", at(2).toISOString()]
      : [evidence?.url, "like", at(1).toISOString()],
  );
  assert.deepEqual(
    listed.map(({ value }) => value),
    [...values, ...person, ...events],
  );
  assert.deepEqual(
    listed.filter(({ kind }) => kind === "claim").map(({ value }) => value),
    [PROOF],
  );
  assert.equal(listed[4]?.sourceRef, `persons/${ours}/first_name`);
  assert.match(String(dossierHash), /^[0-9a-f]{64}$/);
  assert.equal((await dossierOf(workspaceId, ours, member.id)).body.dossierHash, dossierHash);

  const notFound = { status: 404, body: { code: "dossier_lead_not_found" } };
  assert.deepEqual(await dossierOf(workspaceId, unled, member.id), notFound);
  assert.deepEqual(await dossierOf(workspaceId, theirs, member.id), notFound);
});
