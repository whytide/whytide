// approvals' queue routes end to end (beta-p3-030; core/modules/approvals/README.md "Routes"): the
// host started with identity and approvals, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP: the queue with its flags and counts; an approval as
// drafted, edited and with an empty note, refused, by another member, twice and under one key; a
// skip; another workspace refused. The account, the drafts and the items are seeded as linkedin,
// messaging and campaigns leave them. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// The modules by their builds' paths, as src/modules.generated.ts loads them (messaging-drafts.test.ts).
const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
type ApprovalsTesting = typeof import("../../../modules/approvals/dist/testing/index.js");
type MessagingTesting = typeof import("../../../modules/messaging/dist/testing/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const approvals: ApprovalsTesting = await import(built("approvals/dist/testing"));
const messaging: MessagingTesting = await import(built("messaging/dist/testing"));
const linkedin: LinkedinTesting = await import(built("linkedin/dist/testing"));
const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
linkedin.useLinkedinClient(app);
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
      { name: "approvals", load: () => import(built("approvals/dist")) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

const TEXT = "Ines, how does your team follow up on warm leads today? A short question about it.";
const EDITED = "Ines, how does your team follow up on warm leads this week? A short question?";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const HOUR = 3_600_000;

type Answer = { status: number; replayed: string | null; body: any };
/** A request to …/approvals/items<path> of the workspace as the user; a POST under the key given. */
async function send(
  user: string,
  workspaceId: string,
  method: string,
  path = "",
  body?: object,
  key: string = randomUUID(),
): Promise<Answer> {
  const cookie = signInAs(user).map(({ name, value }) => `${name}=${value}`);
  const write = method === "GET" ? {} : { origin: APP_ORIGIN, "idempotency-key": key };
  const json = body === undefined ? {} : { "content-type": "application/json" };
  const headers = { cookie: cookie.join("; "), ...write, ...json };
  const url = new URL(`/v1/workspaces/${workspaceId}/approvals/items${path}`, api.url);
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  const replayed = res.headers.get("idempotent-replayed");
  return { status: res.status, replayed, body: await res.json() };
}

/** The tenant's workspace with a second member, the Owner's sender account and a lead. */
async function seeded(tenant: TestTenant) {
  const workspaceId = tenant.workspace.id;
  const other = await createUser();
  await createMembership({ userId: other.id, workspaceId, role: "Member" });
  const ownerUserId = tenant.user.id;
  const { id: accountId } = await linkedin.createConnectedAccount(workspaceId, { ownerUserId });
  const principal = servicePrincipal("approvals_test");
  const lead = async () => {
    const profile = {
      linkedinUrl: `https://linkedin.com/in/ines-${randomUUID()}`,
      firstName: "Ines",
    };
    const { person } = await upsertPersonFromSource({
      source: "linkedin",
      provider: null,
      profile,
    });
    await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sev_1" } });
    return person.id;
  };
  const personId = await withTenant({ workspaceId, principal }, lead, { client: app });
  let made = 0;
  type Draft = Partial<Parameters<typeof messaging.createStepDraft>[0]>;
  /** An item, its draft `ready` with TEXT, or as given, or none (drafting) for null. */
  type Columns = Partial<Parameters<typeof approvals.createApprovalItem>[0]>;
  const item = async (columns: Columns = {}, draft: Draft | null = {}) => {
    const step = { workspaceId, personId, stepExecutionId: `sx_api${++made}` };
    const draftId = draft && (await messaging.createStepDraft({ ...step, text: TEXT, ...draft }));
    const seed = { ...step, senderAccountId: accountId, draftId, ...columns };
    return { id: await approvals.createApprovalItem(seed), ...step, draftId };
  };
  const as = (user: string) => (method: string, path?: string, body?: object, key?: string) =>
    send(user, workspaceId, method, path, body, key);
  return { workspaceId, accountId, personId, item, owner: as(ownerUserId), other: as(other.id) };
}

const decided = async (workspaceId: string) => {
  const where = { workspaceId, eventName: "approvals.item_decided" };
  return (await app.outboxEntry.findMany({ where })).map((event) => event.payload);
};
const codeOf = ({ status, body }: Answer) => [status, body.code];

test("GET …/approvals/items: pending items and approved ones that wait, by due time, with lead, draft, sender and flags; toApprove and decidedToday; another member reads them without canDecide; another workspace is refused", async () => {
  const [a, b] = await createTwoWorkspaces();
  const { workspaceId, accountId, personId, item, owner, other } = await seeded(a);
  const now = Date.now();
  const at = (hours: number) => new Date(now + hours * HOUR);
  const stale = await item({ scheduledFor: at(-24), createdAt: at(-72 - 1) });
  const drafting = await item({ scheduledFor: at(1) }, null);
  const waits = { status: "approved", waitCode: "insufficient_credits" } as const;
  const waiting = await item({ ...waits, scheduledFor: at(2) });
  await item({ status: "approved", scheduledFor: at(-1) });
  await item({ status: "skipped", decidedAt: at(-48) });
  await item({ status: "blocked" });

  const { status, body } = await owner("GET");
  const flags = body.items.map((row: any) => [
    row.id,
    row.stale,
    row.needsAttention,
    row.canDecide,
  ]);
  assert.deepEqual(
    [status, flags],
    [
      200,
      [
        [stale.id, true, true, true],
        [drafting.id, false, false, true],
        [waiting.id, false, false, true],
      ],
    ],
  );
  assert.deepEqual(body.counts, { toApprove: 2, decidedToday: 2 });
  const [first, second, third] = body.items;
  assert.deepEqual(first.sender, { accountId, label: "LinkedIn", timeZone: "UTC" });
  assert.deepEqual(
    [first.lead.personId, first.lead.firstName, first.lead.why],
    [personId, "Ines", null],
  );
  const { id, status: drafted, text, stepKey, channel, maxCharacters } = first.draft;
  const draft = [id, drafted, text, stepKey, channel, maxCharacters];
  assert.deepEqual(draft, [stale.draftId, "ready", TEXT, "message_1", "linkedin_message", 1_900]);
  assert.deepEqual(
    [second.draft, third.status, third.waitCode],
    [null, "approved", "insufficient_credits"],
  );

  const theirs = (await other("GET")).body.items.map((row: any) => row.canDecide);
  assert.deepEqual(theirs, [false, false, false]);
  assert.equal((await send(b.user.id, workspaceId, "GET")).status, 403);
  const empty = { items: [], counts: { toApprove: 0, decidedToday: 0 } };
  assert.deepEqual((await send(b.user.id, b.workspace.id, "GET")).body, empty);
});

test("POST …/items/{id}/approve: 200 approved as drafted, edited or with an empty note, once under one key, one approvals.item_decided each; refused: another member 403, a refused text 400, drafting 409, decided 409, unknown 404, a bad body 400; nothing changes", async () => {
  const [a] = await createTwoWorkspaces();
  const { workspaceId, item, owner, other } = await seeded(a);
  const drafted = await item();
  const key = randomUUID();
  const first = await owner("POST", `/${drafted.id}/approve`, {}, key);
  const { status, replayed, body } = first;
  assert.deepEqual(
    [status, replayed, body.status, body.draft.status],
    [200, null, "approved", "approved"],
  );
  const again = await owner("POST", `/${drafted.id}/approve`, {}, key);
  assert.deepEqual([again.status, again.replayed, again.body], [200, "true", first.body]);
  const notPending = [409, "approval_item_not_pending"];
  assert.deepEqual(codeOf(await owner("POST", `/${drafted.id}/approve`, {})), notPending);
  assert.deepEqual(codeOf(await owner("POST", `/${drafted.id}/skip`)), notPending);
  const { stepExecutionId } = drafted;
  assert.deepEqual(await decided(workspaceId), [
    { approvalItemId: drafted.id, stepExecutionId, decision: "approved" },
  ]);

  const edited = await item();
  const answer = (await owner("POST", `/${edited.id}/approve`, { text: EDITED })).body;
  assert.deepEqual([answer.draft.text, answer.draft.editedByUser], [EDITED, true]);
  const rows = await app.approvalItem.findMany({ where: { id: { in: [drafted.id, edited.id] } } });
  const hashes = rows.map((row) => row.approvedContentHash).sort();
  assert.deepEqual(hashes, [sha256(TEXT), sha256(EDITED)].sort());
  const invite = await item({ stepKey: "connect" }, { stepKey: "connect", text: "" });
  const note = await owner("POST", `/${invite.id}/approve`, { text: "" });
  assert.deepEqual([note.status, note.body.actionType, note.body.draft.text], [200, "invite", ""]);

  const pending = await item();
  const path = `/${pending.id}/approve`;
  const signal = "Ines, your colleague liked our post. How does your team follow up on warm leads?";
  const drafting = `/${(await item({}, null)).id}/approve`;
  const colleague = await owner("POST", path, { text: signal });
  const refusals = [
    [await other("POST", path, {}), 403, "not_sender_owner"],
    [await other("POST", `/${pending.id}/skip`), 403, "not_sender_owner"],
    [colleague, 400, "draft_text_refused"],
    [await owner("POST", path, { text: "" }), 400, "draft_text_refused"],
    [await owner("POST", drafting, {}), 409, "approval_draft_pending"],
    [await owner("POST", "/apv_unknown/approve", {}), 404, "approval_item_not_found"],
    [await owner("POST", path, { text: "x".repeat(4_001) }), 400, "validation_failed"],
    [await owner("POST", path, { text: TEXT, sent: true }), 400, "validation_failed"],
  ] as const;
  for (const [answered, ...expected] of refusals) assert.deepEqual(codeOf(answered), expected);
  const gates = colleague.body.details.issues.map((issue: { gate: string }) => issue.gate);
  assert.deepEqual(gates, ["colleague_signal"]);
  const row = await app.approvalItem.findUniqueOrThrow({ where: { id: pending.id } });
  assert.deepEqual([row.status, row.decidedBy, row.approvedContentHash], ["pending", null, null]);
  assert.equal((await decided(workspaceId)).length, 3, "the three approvals only");
});

test("POST …/items/{id}/skip: 200 skipped, the draft as it was, one approvals.item_decided; again under another key 409", async () => {
  const [a] = await createTwoWorkspaces();
  const { workspaceId, item, owner } = await seeded(a);
  const step = await item();
  const { status, body } = await owner("POST", `/${step.id}/skip`);
  assert.deepEqual(
    [status, body.status, body.draft.status, body.canDecide],
    [200, "skipped", "ready", true],
  );
  const notPending = [409, "approval_item_not_pending"];
  assert.deepEqual(codeOf(await owner("POST", `/${step.id}/skip`)), notPending);
  assert.deepEqual(codeOf(await owner("POST", `/${step.id}/approve`, {})), notPending);
  const decision = { approvalItemId: step.id, stepExecutionId: step.stepExecutionId };
  assert.deepEqual(await decided(workspaceId), [{ ...decision, decision: "skipped" }]);
});
