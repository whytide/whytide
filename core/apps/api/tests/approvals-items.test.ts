// approvals' queue routes end to end (beta-p3-030; core/modules/approvals/README.md "Routes"): the
// host started with identity and approvals, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP: the queue with its flags and counts, read at 23:59 UTC;
// an approval as drafted, edited and with an empty note, refused, by another member, twice and under
// one key; a skip; another workspace refused; an email item with its mailbox and subject, a stale
// draft and an item opened for the mode (gamma-p4-090); each member's own items and counts, an
// Owner's too, per sender in its zone, past the list's cap, and the decisions of another member's
// item refused (gamma-p6-050). The accounts, the mailboxes, the drafts and the items are seeded as
// linkedin, email, messaging and campaigns leave them. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, type TestContext, test } from "node:test";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
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
/** A minute before midnight UTC, the time a test sets the queue's clock to: its "today" holds. */
const NOW = new Date("2026-11-12T23:59:00.000Z");
/** The list's cap, ITEMS_LIST_MAX (approvals' README "Routes"). */
const ITEMS_LIST_MAX = 200;
const SUBJECT = "Warm leads at Acme";
const EDITED_SUBJECT = "Warm leads this week";

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
  const users = { owner: as(ownerUserId), other: as(other.id), otherId: other.id };
  return { workspaceId, accountId, personId, item, ...users };
}

/** The queue read at NOW, its clock the system's again once the test ends. */
function atNow(t: TestContext) {
  approvals.useQueueClock(() => NOW);
  t.after(() => approvals.useQueueClock(undefined));
  return (hours: number) => new Date(NOW.getTime() + hours * HOUR);
}

/** A connected mailbox of the user, written straight to email's tables as its callback leaves one. */
async function mailboxOf(workspaceId: string, ownerUserId: string, timeZone = "UTC") {
  const sendingDomainId = newId("dom");
  await app.sendingDomain.create({
    data: { id: sendingDomainId, workspaceId, domain: "acme.test" },
  });
  const id = newId("mbx");
  const emailAddress = `member-${randomUUID().slice(0, 8)}@acme.test`;
  const mailbox = { id, workspaceId, ownerUserId, sendingDomainId, emailAddress };
  const columns = { provider: "google" as const, displayName: "Test Member", timeZone };
  // Never opened: the queue reads the mailbox's owner, address and zone only.
  const state = { status: "connected" as const, oauthTokenRef: new Uint8Array([0]), scopes: [] };
  const data = { ...mailbox, ...columns, ...state, isFreeConsumer: false, connectedAt: new Date() };
  await app.mailbox.create({ data });
  return { mailboxId: id, emailAddress };
}

const decided = async (workspaceId: string) => {
  const where = { workspaceId, eventName: "approvals.item_decided" };
  return (await app.outboxEntry.findMany({ where })).map((event) => event.payload);
};
const codeOf = ({ status, body }: Answer) => [status, body.code];
/** A sender of the answer, an account's unless a mailbox is given. */
const senderOf = (
  id: { accountId: string } | { mailboxId: string },
  label: string,
  timeZone: string,
  [toApprove, decidedToday]: readonly [number, number],
) => {
  const ids = "accountId" in id ? { ...id, mailboxId: null } : { accountId: null, ...id };
  return { ...ids, label, timeZone, toApprove, decidedToday };
};
const NONE = { items: [], senders: [], counts: { toApprove: 0, decidedToday: 0 } };

test("GET …/approvals/items at 23:59 UTC: the caller's pending items and approved ones that wait, by due time, with lead, draft, sender and flags; their account with toApprove and decidedToday, since its midnight, and the sums; another member, with no sender, reads none; another workspace is refused", async (t) => {
  const at = atNow(t);
  const [a, b] = await createTwoWorkspaces();
  const { workspaceId, accountId, personId, item, owner, other } = await seeded(a);
  const stale = await item({ scheduledFor: at(-24), createdAt: at(-72 - 1) });
  const drafting = await item({ scheduledFor: at(1), createdAt: at(-1) }, null);
  const waits = { status: "approved", waitCode: "insufficient_credits" } as const;
  const waiting = await item({ ...waits, scheduledFor: at(2), decidedAt: at(-0.5) });
  // Decided at 00:29 today, counted, and at 23:59 yesterday, not.
  await item({ status: "approved", scheduledFor: at(-1), decidedAt: at(-23.5) });
  await item({ status: "skipped", decidedAt: at(-24) });
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
  assert.deepEqual(body.senders, [senderOf({ accountId }, "LinkedIn", "UTC", [2, 2])]);
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

  assert.deepEqual((await other("GET")).body, NONE);
  assert.equal((await send(b.user.id, workspaceId, "GET")).status, 403);
  assert.deepEqual((await send(b.user.id, b.workspace.id, "GET")).body, NONE);
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

test("an email item and the mode's: GET shows the channel, the mailbox as the sender with no account, the subject and its limits, who approves it and mode_declined, the mailbox a sender of its own; POST approve by the mailbox's owner alone, with the subject frozen; a subject on a LinkedIn item 400, a draftId not the item's 409, and nothing changes", async () => {
  const [a] = await createTwoWorkspaces();
  const { workspaceId, accountId, item, owner, other } = await seeded(a);
  const { mailboxId, emailAddress } = await mailboxOf(workspaceId, a.user.id);
  const at = (hours: number) => new Date(Date.now() + hours * HOUR);
  const fromMailbox = { senderAccountId: undefined, mailboxId, stepKey: "email_1" } as const;
  const emailDraft = { stepKey: "email_1", mailboxId, subject: SUBJECT } as const;
  const email = await item({ ...fromMailbox, scheduledFor: at(1) }, emailDraft);
  const declined = { approvalBy: "mode", waitCode: "mode_declined" } as const;
  const byMode = await item({ ...declined, scheduledFor: at(2) });

  const { body } = await owner("GET");
  const rows = body.items.map((row: any) => [
    row.id,
    row.actionType,
    row.channel,
    row.mailboxId,
    row.approvalBy,
    row.waitCode,
  ]);
  assert.deepEqual(rows, [
    [email.id, "email", "email", mailboxId, "person", null],
    [byMode.id, "message", "linkedin", null, "mode", "mode_declined"],
  ]);
  const [shown] = body.items;
  assert.deepEqual(shown.sender, { accountId: null, label: emailAddress, timeZone: "UTC" });
  const { subject, maxSubjectWords, maxSubjectCharacters, channel } = shown.draft;
  assert.deepEqual(
    [subject, maxSubjectWords, maxSubjectCharacters, channel],
    [SUBJECT, 6, 60, "email"],
  );
  // The owner's two senders, by label; another member, with none, reads none of their items.
  assert.deepEqual(
    body.senders.map((sender: any) => [sender.accountId, sender.mailboxId, sender.label]),
    [
      [accountId, null, "LinkedIn"],
      [null, mailboxId, emailAddress],
    ],
  );
  assert.deepEqual((await other("GET")).body, NONE);

  const path = `/${email.id}/approve`;
  const linkedin = await item();
  const refusals = [
    [await other("POST", path, {}), 403, "not_sender_owner"],
    [await other("POST", `/${email.id}/skip`), 403, "not_sender_owner"],
    [await owner("POST", path, { draftId: linkedin.draftId }), 409, "approval_draft_changed"],
    [await owner("POST", path, { subject: "" }), 400, "draft_text_refused"],
    [await owner("POST", path, { subject: SUBJECT, cc: "x" }), 400, "validation_failed"],
    [
      await owner("POST", `/${linkedin.id}/approve`, { subject: SUBJECT }),
      400,
      "approval_subject_not_allowed",
    ],
  ] as const;
  for (const [answered, ...expected] of refusals) assert.deepEqual(codeOf(answered), expected);
  const ids = { id: { in: [email.id, linkedin.id] } };
  const pending = await app.approvalItem.findMany({ where: ids, orderBy: { id: "asc" } });
  assert.deepEqual(
    pending.map((row) => [row.status, row.approvedContentHash]),
    [
      ["pending", null],
      ["pending", null],
    ],
  );
  assert.deepEqual(await decided(workspaceId), []);

  const approved = await owner("POST", path, { subject: EDITED_SUBJECT, draftId: email.draftId });
  assert.deepEqual(
    [approved.status, approved.body.status, approved.body.draft.subject],
    [200, "approved", EDITED_SUBJECT],
  );
  const row = await app.approvalItem.findUniqueOrThrow({ where: { id: email.id } });
  const frozen = JSON.stringify({ body: TEXT, subject: EDITED_SUBJECT });
  assert.equal(row.approvedContentHash, sha256(frozen));
  const decision = { approvalItemId: email.id, stepExecutionId: email.stepExecutionId };
  assert.deepEqual(await decided(workspaceId), [{ ...decision, decision: "approved" }]);
});

test("two members with an account each: each GET holds only the items of the caller's own account, the Owner's included, and counts only those; B's approve and skip of A's item, and the Owner's of B's, are 403 not_sender_owner and change nothing; each decides their own", async (t) => {
  const at = atNow(t);
  const [a] = await createTwoWorkspaces();
  const { workspaceId, accountId, otherId, item, owner, other } = await seeded(a);
  const theirs = await linkedin.createConnectedAccount(workspaceId, { ownerUserId: otherId });
  const fromB = { senderAccountId: theirs.id };
  const mine = [await item({ scheduledFor: at(1) }), await item({ scheduledFor: at(3) })];
  const bs = await item({ ...fromB, scheduledFor: at(2) });
  await item({ ...fromB, status: "skipped", decidedAt: at(-1) });

  const rows = ({ body }: Answer) => body.items.map((row: any) => [row.id, row.canDecide]);
  const asA = await owner("GET");
  assert.deepEqual(rows(asA), [
    [mine[0]?.id, true],
    [mine[1]?.id, true],
  ]);
  assert.deepEqual(asA.body.senders, [senderOf({ accountId }, "LinkedIn", "UTC", [2, 0])]);
  assert.deepEqual(asA.body.counts, { toApprove: 2, decidedToday: 0 });
  const asB = await other("GET");
  assert.deepEqual(rows(asB), [[bs.id, true]]);
  const bSender = senderOf({ accountId: theirs.id }, "LinkedIn", "UTC", [1, 1]);
  assert.deepEqual(asB.body.senders, [bSender]);
  assert.deepEqual(asB.body.counts, { toApprove: 1, decidedToday: 1 });

  const aItem = mine[0]?.id ?? "";
  const refusals = [
    await other("POST", `/${aItem}/approve`, {}),
    await other("POST", `/${aItem}/skip`),
    await owner("POST", `/${bs.id}/approve`, {}),
    await owner("POST", `/${bs.id}/skip`),
  ];
  for (const refused of refusals) assert.deepEqual(codeOf(refused), [403, "not_sender_owner"]);
  for (const id of [aItem, bs.id]) {
    const row = await app.approvalItem.findUniqueOrThrow({ where: { id } });
    assert.deepEqual([row.status, row.decidedBy, row.approvedContentHash], ["pending", null, null]);
  }
  assert.deepEqual(await decided(workspaceId), []);

  assert.equal((await owner("POST", `/${aItem}/approve`, {})).status, 200);
  assert.equal((await other("POST", `/${bs.id}/skip`)).status, 200);
  const decisions = (await decided(workspaceId)) as { approvalItemId: string; decision: string }[];
  const byItem = decisions.map(({ approvalItemId, decision }) => [approvalItemId, decision]);
  const expected = [
    [aItem, "approved"],
    [bs.id, "skipped"],
  ];
  assert.deepEqual(byItem.sort(), expected.sort());
});

test("a member's two senders in two zones, at 23:59 UTC: a LinkedIn account in Kolkata and a mailbox in Los Angeles, each decidedToday counted from its own local midnight, toApprove per sender, by label; the totals their sums", async (t) => {
  atNow(t);
  const [a] = await createTwoWorkspaces();
  const { workspaceId, otherId, item, other } = await seeded(a);
  const timeZone = "Asia/Kolkata";
  const kolkata = await linkedin.createConnectedAccount(workspaceId, {
    ownerUserId: otherId,
    timeZone,
  });
  const zone = "America/Los_Angeles";
  const { mailboxId, emailAddress } = await mailboxOf(workspaceId, otherId, zone);
  // At 23:59 UTC, Kolkata's day began at 18:30 UTC (UTC+5:30), Los Angeles' at 08:00 UTC (UTC-8).
  const utc = (time: string) => new Date(`2026-11-12T${time}:00.000Z`);
  const decidedAt = (time: string) => ({ status: "approved", decidedAt: utc(time) }) as const;
  const fromAccount = { senderAccountId: kolkata.id };
  const fromMailbox = { senderAccountId: undefined, mailboxId };
  await item({ ...fromAccount, ...decidedAt("18:00") }, null);
  await item({ ...fromAccount, ...decidedAt("19:00") }, null);
  await item(fromAccount, null);
  await item({ ...fromMailbox, ...decidedAt("07:30") }, null);
  await item({ ...fromMailbox, status: "skipped", decidedAt: utc("09:00") }, null);
  await item({ ...fromMailbox, ...decidedAt("18:00") }, null);
  await item(fromMailbox, null);
  await item(fromMailbox, null);

  const { body } = await other("GET");
  assert.deepEqual(body.senders, [
    senderOf({ accountId: kolkata.id }, "LinkedIn", timeZone, [1, 1]),
    senderOf({ mailboxId }, emailAddress, zone, [2, 2]),
  ]);
  assert.deepEqual(body.counts, { toApprove: 3, decidedToday: 3 });
  assert.equal(body.items.length, 3);
});

test("more than ITEMS_LIST_MAX items of another member do not push a member's own items out of their list; the Owner's own list stops at ITEMS_LIST_MAX, their toApprove counting them all", async () => {
  const [a] = await createTwoWorkspaces();
  const { workspaceId, otherId, item, owner, other } = await seeded(a);
  const theirs = await linkedin.createConnectedAccount(workspaceId, { ownerUserId: otherId });
  const at = (hours: number) => new Date(Date.now() + hours * HOUR);
  // The Owner's items, all due before the member's one.
  for (let made = 0; made <= ITEMS_LIST_MAX; made++) await item({ scheduledFor: at(-1) }, null);
  const own = await item({ senderAccountId: theirs.id, scheduledFor: at(1) }, null);

  const asB = (await other("GET")).body;
  assert.deepEqual(
    asB.items.map((row: any) => row.id),
    [own.id],
  );
  assert.deepEqual(asB.counts, { toApprove: 1, decidedToday: 0 });
  const asA = (await owner("GET")).body;
  const counted = [asA.items.length, asA.counts.toApprove];
  assert.deepEqual(counted, [ITEMS_LIST_MAX, ITEMS_LIST_MAX + 1]);
});
