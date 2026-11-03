// messaging's draft routes end to end (alpha-p9-020; core/modules/messaging/README.md "Routes"): the
// host started with identity and messaging, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP to a Member; a write sends the app's Origin. The events
// are read from the outbox, and a draft is set `ready` as its writer leaves it: the workflow is the
// worker's test (core/apps/worker/tests/messaging-draft.test.ts). A sequence step's drafts beside
// them (beta-p3-010): never listed, never changed by these routes, read back. An edit runs the gates
// of checkText (beta-p3-020). It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// messaging by its build's path, as src/modules.generated.ts loads it (messaging-dossier.test.ts).
const messaging = new URL("../../../../modules/messaging/dist/index.js", import.meta.url).href;
type MessagingTesting = typeof import("../../../modules/messaging/dist/testing/index.js");
const testing = new URL("../../../../modules/messaging/dist/testing/index.js", import.meta.url);
const { createStepDraft }: MessagingTesting = await import(testing.href);
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
      { name: "messaging", load: () => import(messaging) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; replayed: string | null; body: Record<string, unknown> };
/** A request to …/messaging/<path> of the workspace as the user; a POST under the key given. */
async function send(
  user: string,
  workspaceId: string,
  method: string,
  path: string,
  body?: object,
  key: string = randomUUID(),
): Promise<Answer> {
  const cookie = signInAs(user)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const write = method === "GET" ? {} : { origin: APP_ORIGIN };
  const idempotent = method === "POST" ? { "idempotency-key": key } : {};
  const json = body === undefined ? {} : { "content-type": "application/json" };
  const headers = { cookie, ...write, ...idempotent, ...json };
  const url = new URL(`/v1/workspaces/${workspaceId}/messaging/${path}`, api.url);
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  const answer = (await res.json()) as Record<string, unknown>;
  return { status: res.status, replayed: res.headers.get("idempotent-replayed"), body: answer };
}

/** A person of the workspace with a lead. */
const seedLead = (workspaceId: string) =>
  withTenant(
    { workspaceId, principal: servicePrincipal("messaging_test") },
    async () => {
      const profile = {
        linkedinUrl: `https://linkedin.com/in/ines-${randomUUID()}`,
        firstName: "Ines",
        lastName: "Duarte",
      };
      const { person } = await upsertPersonFromSource({
        source: "linkedin",
        provider: null,
        profile,
      });
      await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sev_1" } });
      return person.id;
    },
    { client: asRole("app") },
  );

const TEXT = "Ines, how does your team follow up on warm leads today? A short question about it.";
const OWN = "Ines, my own words, as I would say them.";

test("criterion 5 through the routes: a draft asked for answers 202 drafting with one event, its key again the same; an edit makes it edited, within the channel's limit; its regeneration is a new row and the edited one is unchanged; newest first; another workspace's is not found", async () => {
  const [a, b] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const personId = await seedLead(workspaceId);
  const as = (method: string, path: string, body?: object, key?: string) =>
    send(member.id, workspaceId, method, path, body, key);

  const [key, message] = [randomUUID(), { channel: "linkedin_message" }];
  const asked = await as("POST", `leads/${personId}/drafts`, message, key);
  const { id } = asked.body as { id: string };
  const { status, personId: lead, text, maxCharacters } = asked.body;
  assert.deepEqual(
    [asked.status, asked.replayed, status, lead, text, maxCharacters],
    [202, null, "drafting", personId, null, 1_900],
    "a message's limit, which the draft panel counts against (alpha-p9-030)",
  );
  assert.deepEqual(await as("POST", `leads/${personId}/drafts`, message, key), {
    ...asked,
    replayed: "true",
  });
  const notEditable = { status: 409, replayed: null, body: { code: "draft_not_editable" } };
  assert.deepEqual(await as("PATCH", `drafts/${id}`, { editedText: OWN }), notEditable);

  await asRole("app").messageDraft.update({ where: { id }, data: { status: "ready", text: TEXT } });
  const tooLong = { editedText: "x".repeat(1_901) };
  assert.deepEqual((await as("PATCH", `drafts/${id}`, tooLong)).body, {
    code: "messaging_input_invalid",
    details: { fields: ["editedText"] },
  });
  const edited = await as("PATCH", `drafts/${id}`, { editedText: OWN });
  assert.deepEqual(
    [edited.status, edited.body.status, edited.body.text, edited.body.editedText],
    [200, "edited", TEXT, OWN],
  );
  const again = await as("POST", `drafts/${id}/regenerate`);
  const next = again.body as { id: string };
  assert.deepEqual(
    [again.status, again.body.status, again.body.personId, again.body.channel],
    [202, "drafting", personId, "linkedin_message"],
  );
  assert.notEqual(next.id, id);
  assert.deepEqual((await as("POST", `drafts/${next.id}/regenerate`)).body, notEditable.body);
  assert.deepEqual(
    (await as("GET", `drafts/${id}`)).body,
    edited.body,
    "the edited row, unchanged",
  );
  const listed = (await as("GET", `leads/${personId}/drafts`)).body as { drafts: { id: string }[] };
  assert.deepEqual(
    listed.drafts.map((draft) => draft.id),
    [next.id, id],
  );

  const where = { workspaceId, eventName: "messaging.draft_requested" };
  const outbox = await asRole("app").outboxEntry.findMany({ where, orderBy: { createdAt: "asc" } });
  const event = { workspaceId, personId, userId: member.id };
  assert.deepEqual(
    outbox.map((row) => row.payload),
    [
      { ...event, draftId: id },
      { ...event, draftId: next.id, replacesId: id },
    ],
    "one event per draft, ids only: a replay publishes nothing",
  );

  const notFound = { code: "draft_not_found" };
  assert.deepEqual((await as("GET", "drafts/mdr_none")).body, notFound);
  assert.deepEqual((await send(b.user.id, b.workspace.id, "GET", `drafts/${id}`)).body, notFound);
  const noLead = await as("POST", "leads/per_none/drafts", { channel: "linkedin_note" });
  assert.deepEqual([noLead.status, noLead.body], [404, { code: "dossier_lead_not_found" }]);
});

test("a sequence step's drafts beside the lead's: the list holds none; PATCH and regenerate answer 409 step_draft_not_editable and change nothing; an `approved` one reads back with its kind", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const personId = await seedLead(workspaceId);
  const as = (method: string, path: string, body?: object) =>
    send(member.id, workspaceId, method, path, body);
  const step = { workspaceId, personId, text: TEXT };
  const approved = await createStepDraft(
    { ...step, stepExecutionId: "sx_approved", status: "approved" },
    asRole("app"),
  );
  const ready = await createStepDraft({ ...step, stepExecutionId: "sx_ready" }, asRole("app"));
  const lead = (await as("POST", `leads/${personId}/drafts`, { channel: "linkedin_note" })).body;

  const listed = (await as("GET", `leads/${personId}/drafts`)).body as {
    drafts: { id: string; kind: string }[];
  };
  assert.deepEqual(listed.drafts, [{ ...lead, kind: "lead_draft" }]);
  const refused = { status: 409, replayed: null, body: { code: "step_draft_not_editable" } };
  for (const id of [approved, ready]) {
    const before = (await as("GET", `drafts/${id}`)).body;
    assert.deepEqual(await as("PATCH", `drafts/${id}`, { editedText: OWN }), refused);
    assert.deepEqual(await as("POST", `drafts/${id}/regenerate`), refused);
    assert.deepEqual((await as("GET", `drafts/${id}`)).body, before, "unchanged");
  }
  const read = await as("GET", `drafts/${approved}`);
  const { kind, status, channel, text, editedText } = read.body;
  assert.deepEqual(
    [read.status, kind, status, channel, text, editedText],
    [200, "outbound_step", "approved", "linkedin_message", TEXT, null],
  );
  const requested = await asRole("app").outboxEntry.count({
    where: { workspaceId, eventName: "messaging.draft_requested" },
  });
  assert.equal(requested, 1, "the lead's draft only: a refused regeneration publishes nothing");
});

test("an edit runs the gates: PATCH with a red line, a colleague's signal or a placeholder answers 400 draft_text_refused with the gate's issue and changes nothing; a lead draft's empty note is refused, as in alpha", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const personId = await seedLead(workspaceId);
  const as = (method: string, path: string, body?: object) =>
    send(member.id, workspaceId, method, path, body);
  const ask = async (channel: string) =>
    ((await as("POST", `leads/${personId}/drafts`, { channel })).body as { id: string }).id;
  const [message, note] = [await ask("linkedin_message"), await ask("linkedin_note")];
  for (const id of [message, note]) {
    await asRole("app").messageDraft.update({
      where: { id },
      data: { status: "ready", text: TEXT },
    });
  }
  const before = (await as("GET", `drafts/${message}`)).body;
  const refused: [string, object][] = [
    ["Ines, as we discussed: a short question.", { gate: "red_lines", phrase: "as we discussed" }],
    [
      "Ines, your colleagues liked our post. A question?",
      { gate: "colleague_signal", phrase: "your colleagues" },
    ],
    ["Hi [Name], a short question.", { gate: "placeholders", placeholder: "[Name]" }],
  ];
  for (const [editedText, issue] of refused) {
    const body = { code: "draft_text_refused", details: { issues: [issue] } };
    const answer = await as("PATCH", `drafts/${message}`, { editedText });
    assert.deepEqual(answer, { status: 400, replayed: null, body }, editedText);
  }
  assert.deepEqual((await as("GET", `drafts/${message}`)).body, before, "unchanged");

  const empty = await as("PATCH", `drafts/${note}`, { editedText: "" });
  const invalid = { code: "validation_failed", details: { fields: ["editedText"] } };
  assert.deepEqual([empty.status, empty.body], [400, invalid]);
  const blank = await as("PATCH", `drafts/${note}`, { editedText: "  " });
  const input = { code: "messaging_input_invalid", details: { fields: ["editedText"] } };
  assert.deepEqual([blank.status, blank.body], [400, input]);
  const edited = await as("PATCH", `drafts/${note}`, { editedText: OWN });
  assert.deepEqual(
    [edited.status, edited.body.status, edited.body.editedText],
    [200, "edited", OWN],
  );
});
