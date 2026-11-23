// inbox's routes end to end (beta-p5-040; core/modules/inbox/README.md "API"): the host started with
// identity and inbox, on the fake authentication adapter, in a schema of the worktree's database,
// answering real HTTP: the threads newest first, a page at a time, each with its lead, who wrote last
// and its replies to label; a thread with its messages, oldest first; a reply labeled by the
// thread's owner with one of the 7, confirming the suggestion, again, then changed (gamma-p4-055);
// the refusals; a member, and another workspace's user, thread and message. A reply's
// classification, and a thread's newest reply's label (gamma-p4-040). Two members with an account
// each (gamma-p6-060): each lists, pages through, reads and labels their own threads only, an
// Owner's included, another member's thread and message not found. Threads, messages, labels and
// classifications are seeded as the store leaves them (@whytide/inbox/testing), the leads by
// contacts' commands. No route calls the LinkedIn fake. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
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

// inbox by its build's path, as src/modules.generated.ts loads it: the api lists no module with a
// screen (approvals-items.test.ts).
const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
type InboxTesting = typeof import("../../../modules/inbox/dist/testing/index.js");
const inbox: InboxTesting = await import(built("inbox/dist/testing"));
const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
useHashSalt("test-salt-".repeat(4));
const linkedin = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "inbox", load: () => import(built("inbox/dist")) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

const HOUR = 3_600_000;
const REPLY = "Thanks, next week works. Tuesday?";
type Answer = { status: number; body: any };

/** A request to …/inbox<path> of the workspace as the user; a write with the app's origin only. */
async function send(
  user: string,
  workspaceId: string,
  method: string,
  path: string,
  body?: object,
): Promise<Answer> {
  const cookie = signInAs(user).map(({ name, value }) => `${name}=${value}`);
  const write = method === "GET" ? {} : { origin: APP_ORIGIN };
  const json = body === undefined ? {} : { "content-type": "application/json" };
  const headers = { cookie: cookie.join("; "), ...write, ...json };
  const url = new URL(`/v1/workspaces/${workspaceId}/inbox${path}`, api.url);
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const codeOf = ({ status, body }: Answer) => [status, body.code];

/**
 * The tenant's workspace with a Member, each with an account of their own. Three leads and their
 * threads on the Owner's account: Ana's, the oldest, the campaign's message and her reply, its label
 * only suggested; Ben's, as old, the campaign's message, his reply labeled positive by the Owner with
 * beta's buttons, a row with no class, and the Owner's answer typed on LinkedIn; Cora's, the newest,
 * the campaign's message alone. Two on the Member's, between the Owner's in time: Dana's, newer than
 * Ben's, and Eve's, older than Ana's, each with her reply.
 */
async function seeded(tenant: TestTenant) {
  const workspaceId = tenant.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const principal = servicePrincipal("inbox_test");
  const lead = (firstName: string) =>
    withTenant(
      { workspaceId, principal },
      async () => {
        const slug = `${firstName.toLowerCase()}-${randomUUID()}`;
        const profile = {
          ...{ linkedinUrl: `https://linkedin.com/in/${slug}`, firstName, lastName: "Lead" },
          ...{ title: "Head of Data", companyName: "Blue Harbor Labs" },
        };
        const { person } = await upsertPersonFromSource({
          source: "linkedin",
          provider: null,
          profile,
        });
        await createLeadForPerson({
          personId: person.id,
          source: { kind: "signal", ref: "sev_1" },
        });
        return person.id;
      },
      { client: app },
    );
  const now = Date.now();
  const at = (hours: number) => new Date(now + hours * HOUR);
  const thread = async (personId: string, lastMessageAt: Date, ownerUserId = tenant.user.id) => {
    // Each member's own account: the thread's owner_user_id is its owner, as the store writes it.
    const senderAccountId = ownerUserId === member.id ? "sac_inbox_member" : "sac_inbox_owner";
    const threadId = await inbox.createThread({
      workspaceId,
      personId,
      ownerUserId,
      senderAccountId,
      lastMessageAt,
    });
    type Message = Omit<Parameters<InboxTesting["createMessage"]>[0], "workspaceId" | "threadId">;
    const message = (given: Omit<Message, "personId">) =>
      inbox.createMessage({ workspaceId, threadId, personId, ...given });
    return { threadId, message };
  };
  const campaign = (sentAt: Date) =>
    ({ direction: "out", sentBy: "campaign", sentAt, approvedAt: at(-30) }) as const;

  const ana = await lead("Ana");
  const anas = await thread(ana, at(-1));
  const anaOut = await anas.message(campaign(at(-3)));
  const anaReply = await anas.message({ body: REPLY, sentAt: at(-1) });
  const ben = await lead("Ben");
  const bens = await thread(ben, at(-1));
  const benOut = await bens.message(campaign(at(-4)));
  const benReply = await bens.message({ sentAt: at(-2) });
  const label = { workspaceId, messageId: benReply, label: "positive" as const };
  await inbox.createLabel({ ...label, labeledBy: tenant.user.id, labeledAt: at(-1.5) });
  const typed = {
    direction: "out",
    sentBy: "user",
    body: "Tuesday works.",
    sentAt: at(-1),
  } as const;
  const benTyped = await bens.message(typed);
  const anaClass = { workspaceId, threadId: anas.threadId, personId: ana, messageId: anaReply };
  const suggested = { label: "interested", confidence: 0.55, isSuggested: true };
  await inbox.createClassification({ ...anaClass, ...suggested });
  const benClass = { workspaceId, threadId: bens.threadId, personId: ben, messageId: benReply };
  await inbox.createClassification({
    ...benClass,
    label: "out_of_office",
    returnDate: "2026-11-24",
  });
  const cora = await lead("Cora");
  const coras = await thread(cora, at(0));
  await coras.message(campaign(at(0)));
  const dana = await lead("Dana");
  const danas = await thread(dana, at(-0.5), member.id);
  await danas.message(campaign(at(-3)));
  const danaReply = await danas.message({ body: REPLY, sentAt: at(-0.5) });
  const eve = await lead("Eve");
  const eves = await thread(eve, at(-2), member.id);
  await eves.message(campaign(at(-4)));
  const eveReply = await eves.message({ body: REPLY, sentAt: at(-2) });

  const as = (user: string) => (method: string, path: string, body?: object) =>
    send(user, workspaceId, method, path, body);
  return {
    ...{ workspaceId, at, ana, ben, cora, anaOut, anaReply, benOut, benReply, benTyped },
    ...{ dana, eve, danaReply, eveReply },
    threads: {
      ...{ ana: anas.threadId, ben: bens.threadId, cora: coras.threadId },
      ...{ dana: danas.threadId, eve: eves.threadId },
    },
    owner: as(tenant.user.id),
    member: as(member.id),
  };
}

test("GET …/inbox/threads: the caller's own threads only, an Owner's and a Member's, newest first, the tie by id, each with its lead, who wrote last, its replies to label and its newest reply's label, a page at a time, each once; refused: a cursor the list did not write, a limit over 50, another workspace's user; no provider call", async () => {
  const [a, b] = await createTwoWorkspaces();
  const seed = await seeded(a);
  linkedin.reset();
  const { status, body } = await seed.owner("GET", "/threads");
  assert.equal(status, 200);
  const rows = body.threads.map((row: any) => [
    row.id,
    row.personId,
    row.lastDirection,
    row.toLabel,
  ]);
  // Ana's and Ben's last messages share an instant: the later thread, Ben's, sorts first.
  assert.deepEqual(rows, [
    [seed.threads.cora, seed.cora, "out", 0],
    [seed.threads.ben, seed.ben, "out", 0],
    [seed.threads.ana, seed.ana, "in", 1],
  ]);
  assert.equal(body.nextCursor, null);
  assert.deepEqual(
    body.threads.map((row: any) => row.classification),
    [
      null,
      { label: "out_of_office", isSuggested: false },
      { label: "interested", isSuggested: true },
    ],
    "each thread's newest reply's label",
  );
  const [first] = body.threads;
  const person = { firstName: "Cora", lastName: "Lead", title: "Head of Data" };
  assert.deepEqual(first.person, { ...person, companyName: "Blue Harbor Labs" });
  assert.equal(first.lastMessageAt, seed.at(0).toISOString());
  assert.equal(typeof first.senderAccountId, "string");

  const page = await seed.owner("GET", "/threads?limit=2");
  const ids = page.body.threads.map((row: any) => row.id);
  assert.deepEqual([page.status, ids], [200, [seed.threads.cora, seed.threads.ben]]);
  const cursor = encodeURIComponent(page.body.nextCursor);
  const next = await seed.owner("GET", `/threads?limit=2&cursor=${cursor}`);
  const rest = next.body.threads.map((row: any) => row.id);
  assert.deepEqual([next.status, rest, next.body.nextCursor], [200, [seed.threads.ana], null]);

  // The Member: their own two, between the Owner's in time, one a page; none of the Owner's.
  const theirs = await seed.member("GET", "/threads");
  const own = theirs.body.threads.map((row: any) => [row.id, row.personId, row.toLabel]);
  assert.deepEqual(
    [theirs.status, own],
    [
      200,
      [
        [seed.threads.dana, seed.dana, 1],
        [seed.threads.eve, seed.eve, 1],
      ],
    ],
  );
  const paged: string[] = [];
  let after: string | null = null;
  do {
    const query: string = after === null ? "" : `&cursor=${encodeURIComponent(after)}`;
    const one = await seed.member("GET", `/threads?limit=1${query}`);
    assert.equal(one.status, 200);
    paged.push(...one.body.threads.map((row: any) => row.id));
    after = one.body.nextCursor;
  } while (after !== null);
  assert.deepEqual(paged, [seed.threads.dana, seed.threads.eve], "every one once, in order");

  const invalid = [400, "validation_failed"];
  assert.deepEqual(codeOf(await seed.owner("GET", "/threads?cursor=not-a-cursor")), invalid);
  const forged = Buffer.from(JSON.stringify(["yesterday", "thr_1"])).toString("base64url");
  assert.deepEqual(codeOf(await seed.owner("GET", `/threads?cursor=${forged}`)), invalid);
  assert.deepEqual(codeOf(await seed.owner("GET", "/threads?limit=51")), invalid);
  const outsider = await send(b.user.id, seed.workspaceId, "GET", "/threads");
  assert.deepEqual(codeOf(outsider), [403, "forbidden"]);
  const bs = await send(b.user.id, b.workspace.id, "GET", "/threads");
  assert.deepEqual(bs.body, { threads: [], nextCursor: null }, "B sees none of A's threads");
  assert.deepEqual(linkedin.recordedCalls, []);
});

test("GET …/inbox/threads/{id}: the caller's own thread, its lead and its messages oldest first, each reply with its label and its classification or null, an outbound one with none; another member's thread, either way, another workspace's and an unknown one are 404 thread_not_found", async () => {
  const [a, b] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const theirs = await seeded(b);
  linkedin.reset();
  const { status, body } = await seed.owner("GET", `/threads/${seed.threads.ben}`);
  assert.equal(status, 200);
  assert.deepEqual(
    [body.id, body.personId, body.person.firstName, body.lastDirection, body.toLabel],
    [seed.threads.ben, seed.ben, "Ben", "out", 0],
  );
  const messages = body.messages.map((message: any) => [
    message.id,
    message.direction,
    message.sentBy,
    message.approvedAt === null,
  ]);
  assert.deepEqual(messages, [
    [seed.benOut, "out", "campaign", false],
    [seed.benReply, "in", null, true],
    [seed.benTyped, "out", "user", true],
  ]);
  const [campaign, reply, typed] = body.messages;
  assert.equal(campaign.approvedAt, seed.at(-30).toISOString());
  assert.equal(typed.body, "Tuesday works.");
  const label = { label: "positive", classLabel: null, labeledAt: seed.at(-1.5).toISOString() };
  assert.deepEqual(reply.label, { ...label, labeledBy: a.user.id }, "beta's row: no class");
  assert.deepEqual([campaign.label, typed.label], [null, null]);
  const ooo = { label: "out_of_office", isSuggested: false, confidence: 0.9 };
  assert.deepEqual(reply.classification, { ...ooo, returnDate: "2026-11-24" });
  assert.deepEqual([campaign.classification, typed.classification], [null, null]);
  const ana = await seed.owner("GET", `/threads/${seed.threads.ana}`);
  const replied = ana.body.messages.at(-1);
  assert.deepEqual([replied.body, replied.label, ana.body.toLabel], [REPLY, null, 1]);

  const own = await seed.member("GET", `/threads/${seed.threads.dana}`);
  const read = [own.status, own.body.id, own.body.messages.at(-1).id, own.body.reply.own];
  assert.deepEqual(read, [200, seed.threads.dana, seed.danaReply, true], "the Member's own");

  const notFound = [404, "thread_not_found"];
  const members = await seed.member("GET", `/threads/${seed.threads.ben}`);
  assert.deepEqual(codeOf(members), notFound, "the Owner's thread, to the Member");
  assert.deepEqual(members.body, { code: "thread_not_found" }, "nothing of whose it is");
  const owners = await seed.owner("GET", `/threads/${seed.threads.dana}`);
  assert.deepEqual(codeOf(owners), notFound, "the Member's thread, to an Owner");
  const other = await seed.owner("GET", `/threads/${theirs.threads.ana}`);
  assert.deepEqual(codeOf(other), notFound);
  assert.deepEqual(codeOf(await seed.owner("GET", "/threads/thr_unknown")), notFound);
  assert.deepEqual(linkedin.recordedCalls, []);
});

test("PUT …/inbox/messages/{id}/label: the thread's owner confirms the suggestion, one row with the class, beta's word, the user and the time; again changes nothing; another label changes the same row, which the thread then shows; refused: another member's thread, either way, 404 inbox_message_not_found, nothing written; beta's positive and not_positive 400; an outbound message 409 message_not_inbound; an unknown or another workspace's 404; a bad body 400; no Idempotency-Key, no provider call", async () => {
  const [a, b] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const theirs = await seeded(b);
  linkedin.reset();
  const path = `/messages/${seed.anaReply}/label`;
  const rows = () => app.replyLabel.findMany({ where: { messageId: seed.anaReply } });
  const notFound = [404, "inbox_message_not_found"];
  const members = await seed.member("PUT", path, { label: "interested" });
  assert.deepEqual(codeOf(members), notFound, "only the thread's owner labels its replies");
  assert.deepEqual(await rows(), [], "nothing written");
  const theMembers = `/messages/${seed.danaReply}/label`;
  const owners = await seed.owner("PUT", theMembers, { label: "interested" });
  assert.deepEqual(codeOf(owners), notFound, "nor an Owner another member's");
  const danas = await app.replyLabel.findMany({ where: { messageId: seed.danaReply } });
  assert.deepEqual(danas, [], "nothing written");

  const confirmed = await seed.owner("PUT", path, { label: "interested" });
  assert.equal(confirmed.status, 200);
  const { labeledAt, ...chosen } = confirmed.body;
  assert.deepEqual(chosen, { label: "positive", classLabel: "interested", labeledBy: a.user.id });
  const [stored] = await rows();
  assert.deepEqual(
    [stored?.label, stored?.classLabel, stored?.labeledBy, stored?.labeledAt.toISOString()],
    ["positive", "interested", a.user.id, labeledAt],
  );
  const again = await seed.owner("PUT", path, { label: "interested" });
  assert.deepEqual([again.status, again.body], [200, confirmed.body], "a repeat changes nothing");

  const changed = await seed.owner("PUT", path, { label: "not_interested" });
  assert.equal(changed.status, 200);
  assert.deepEqual(
    [changed.body.label, changed.body.classLabel],
    ["not_positive", "not_interested"],
  );
  const changedRows = await rows();
  assert.deepEqual(
    changedRows.map(({ id, label, classLabel }) => [id, label, classLabel]),
    [[stored?.id, "not_positive", "not_interested"]],
    "the same row, changed",
  );
  const thread = await seed.owner("GET", `/threads/${seed.threads.ana}`);
  assert.deepEqual([thread.body.toLabel, thread.body.messages.at(-1).label], [0, changed.body]);
  const shown = { label: "not_interested", isSuggested: false };
  assert.deepEqual(thread.body.classification, shown, "the owner's label, not the suggestion");
  const list = await seed.owner("GET", "/threads");
  const row = list.body.threads.find(({ id }: { id: string }) => id === seed.threads.ana);
  assert.deepEqual([row.toLabel, row.classification], [0, shown]);

  const invalid = [400, "validation_failed"];
  for (const word of ["positive", "not_positive"]) {
    assert.deepEqual(codeOf(await seed.owner("PUT", path, { label: word })), invalid, word);
  }
  const outbound = await seed.owner("PUT", `/messages/${seed.anaOut}/label`, {
    label: "interested",
  });
  assert.deepEqual(codeOf(outbound), [409, "message_not_inbound"]);
  const label = { label: "interested" };
  assert.deepEqual(codeOf(await seed.owner("PUT", "/messages/msg_unknown/label", label)), notFound);
  const other = await seed.owner("PUT", `/messages/${theirs.anaReply}/label`, label);
  assert.deepEqual(codeOf(other), notFound);
  assert.deepEqual(codeOf(await seed.owner("PUT", path, { label: "maybe" })), invalid);
  assert.deepEqual(codeOf(await seed.owner("PUT", path, { ...label, sent: true })), invalid);
  const outsider = await send(b.user.id, seed.workspaceId, "PUT", path, label);
  assert.deepEqual(codeOf(outsider), [403, "forbidden"]);
  const untouched = await app.replyLabel.findMany({
    where: { messageId: { in: [seed.anaOut, theirs.anaReply] } },
  });
  assert.deepEqual(untouched, []);
  assert.deepEqual((await rows()).length, 1);
  assert.deepEqual(linkedin.recordedCalls, []);
});
