// inbox's reply golden set end to end (beta-p7-030; core/modules/inbox/README.md "The reply golden
// set"): the host started with identity and inbox, on the fake authentication adapter, in a schema of
// the worktree's database, the files port on the slice's own storage (.env.local), answering real
// HTTP. Leads by contacts' commands; threads, messages and labels as the store and the label leave
// them (@whytide/inbox/testing), one label changed through the label's route by the thread's owner,
// two of the 7 labels written as beta's two words (gamma-p4-055). The lines, with their channel, the
// owner's class, the classification and the phrases' match (gamma-p7-060), ?week, the content type,
// the file in the files port, another workspace, the permission: inbox.export, an Owner's or an
// Admin's, a Member refused (gamma-p7-060); each file holds the caller's own threads' replies only
// (gamma-p6-060). It lives here: a module never imports a
// host. Made-up names only.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { after, before, test } from "node:test";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
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
  new URL(`../../../../modules/inbox/dist/${path}`, import.meta.url).href;
type InboxTesting = typeof import("../../../modules/inbox/dist/testing/index.js");
type Exports = typeof import("../../../modules/inbox/dist/api/exports.controller.js");
const inbox: InboxTesting = await import(built("testing/index.js"));
const { ExportsController }: Exports = await import(built("api/exports.controller.js"));
const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
inbox.useInboxExportClient(app);
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
      { name: "inbox", load: () => import(built("index.js")) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const cookieOf = (user: string) =>
  signInAs(user)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
/** GET …/inbox/exports/reply-labels.jsonl of the workspace as the user, with the lines it answers. */
async function exported(user: string, workspaceId: string, query = "") {
  const path = `/v1/workspaces/${workspaceId}/inbox/exports/reply-labels.jsonl${query}`;
  const res = await fetch(new URL(path, api.url), { headers: { cookie: cookieOf(user) } });
  const body = await res.text();
  const lines = res.ok
    ? body
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { res, body, lines: lines as Record<string, any>[] };
}
/** The file name the answer gives. */
const fileOf = (res: Response) =>
  /^attachment; filename="(reply-labels-[\w-]+\.jsonl)"$/.exec(
    res.headers.get("content-disposition") ?? "",
  )?.[1];
/** The stored file of a whole key. */
async function stored(workspaceId: string, key: string) {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  return text((await files.get({ workspaceId, key })).body);
}
/** The ISO week of a day, `2026-W44`, in UTC: its Thursday's year and week. */
function isoWeek(day: Date): string {
  const monday = (day.getUTCDay() + 6) % 7;
  const thursday = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 3 - monday),
  );
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** A lead of the workspace, made by contacts' commands: the person's id. */
const lead = (workspaceId: string, firstName: string, lastName: string) =>
  withTenant(
    { workspaceId, principal: servicePrincipal("inbox_test") },
    async () => {
      const linkedinUrl = `https://linkedin.com/in/${firstName.toLowerCase()}-${randomUUID()}`;
      const profile = { linkedinUrl, firstName, lastName, title: "Head of Data" };
      const { person } = await upsertPersonFromSource({
        source: "linkedin",
        provider: null,
        profile,
      });
      await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sev_1" } });
      return person.id;
    },
    { client: app },
  );
/** A thread of the person, on the account of the owner given, and a writer of its messages. */
async function threadOf(workspaceId: string, personId: string, ownerUserId: string) {
  const threadId = await inbox.createThread({ workspaceId, personId, ownerUserId });
  type Message = Parameters<InboxTesting["createMessage"]>[0];
  const message = (given: Omit<Message, "workspaceId" | "threadId" | "personId">) =>
    inbox.createMessage({ workspaceId, threadId, personId, ...given });
  return { threadId, message };
}
/**
 * A reply of the person on the thread of `owner`, the tenant's Owner unless given, labeled by them
 * `ago` before now: the reply's id.
 */
async function labeledReply(
  tenant: TestTenant,
  names: [string, string],
  label: "positive" | "not_positive",
  ago: number,
  owner: string = tenant.user.id,
) {
  const workspaceId = tenant.workspace.id;
  const personId = await lead(workspaceId, ...names);
  const { threadId, message } = await threadOf(workspaceId, personId, owner);
  const now = Date.now();
  await message({ direction: "out", sentBy: "campaign", sentAt: new Date(now - ago - 2 * MINUTE) });
  const messageId = await message({ body: "Happy to talk.", sentAt: new Date(now - ago - MINUTE) });
  const labeledAt = new Date(now - ago);
  await inbox.createLabel({ workspaceId, messageId, label, labeledBy: owner, labeledAt });
  return { personId, threadId, messageId };
}

test("GET …/inbox/exports/reply-labels.jsonl: a line per labeled reply, its latest label, with the conversation before it, the latest ten, oldest first; no line for an unlabeled reply or an outbound message; no id or name; application/jsonl, and the same file under exports/", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const now = Date.now();
  const at = (minutes: number) => new Date(now + minutes * MINUTE);

  // Ottoline's thread: twelve messages, then her reply, labeled through the route, then changed;
  // then the account's answer.
  const ottoline = await lead(workspaceId, "Ottoline", "Vashti");
  const ours = await threadOf(workspaceId, ottoline, a.user.id);
  const before = Array.from({ length: 12 }, (_, i) => {
    const direction = i % 2 === 0 ? "out" : "in";
    const sentBy = direction === "in" ? undefined : i === 0 ? "campaign" : "user";
    return {
      direction,
      sentBy,
      body: `Message ${i}: hello Ottoline Vashti`,
      sentAt: at(i - 30),
    } as const;
  });
  for (const message of before) await ours.message(message);
  const reply = await ours.message({ body: "Yes OTTOLINE here, Tuesday works", sentAt: at(-10) });
  await ours.message({
    direction: "out",
    sentBy: "user",
    body: "Tuesday, Ottoline.",
    sentAt: at(-5),
  });
  const label = (value: string) =>
    fetch(new URL(`/v1/workspaces/${workspaceId}/inbox/messages/${reply}/label`, api.url), {
      method: "PUT",
      headers: {
        cookie: cookieOf(a.user.id),
        origin: APP_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: value }),
    });
  assert.equal((await label("interested")).status, 200);
  const changed = await label("not_now");
  assert.equal(changed.status, 200);
  const { labeledAt } = (await changed.json()) as { labeledAt: string };

  // Bramwell's thread: the campaign's message, labeled straight in the table; a labeled reply and an
  // unlabeled one.
  const bramwell = await lead(workspaceId, "Bramwell", "Okonkwo");
  const theirs = await threadOf(workspaceId, bramwell, a.user.id);
  const opening = await theirs.message({
    ...{ direction: "out", sentBy: "campaign", sentAt: at(-60) },
    body: "Hi Bramwell, a question about your data team.",
  });
  const answered = await theirs.message({ body: "Not now, thanks.", sentAt: at(-50) });
  await theirs.message({ body: "Bramwell again: next month?", sentAt: at(-30) });
  const owner = { workspaceId, labeledBy: a.user.id };
  await inbox.createLabel({ ...owner, messageId: answered, label: "positive", labeledAt: at(-40) });
  await inbox.createLabel({ ...owner, messageId: opening, label: "positive", labeledAt: at(-39) });
  await inbox.createClassification({
    ...{ workspaceId, messageId: answered, threadId: theirs.threadId, personId: bramwell },
    ...{ label: "not_now", confidence: 0.55, isSuggested: true },
  });

  const { res, body, lines } = await exported(a.user.id, workspaceId);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/jsonl; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const name = fileOf(res);
  assert.equal(name, `reply-labels-${new Date().toISOString().slice(0, 10)}.jsonl`);
  assert.ok(body.endsWith("\n"));
  assert.deepEqual(lines, [
    {
      person_sha256: sha256(bramwell),
      thread_sha256: sha256(theirs.threadId),
      channel: "linkedin",
      label: "positive",
      class_label: null,
      labeled_at: at(-40).toISOString(),
      received_at: at(-50).toISOString(),
      text: "Not now, thanks.",
      opt_out_matched: false,
      classification: {
        label: "not_now",
        confidence: 0.55,
        is_suggested: true,
        origin: "model",
        prompt_version: 1,
      },
      earlier: [
        {
          direction: "out",
          sent_by: "campaign",
          text: "Hi [first_name], a question about your data team.",
          at: at(-60).toISOString(),
        },
      ],
    },
    {
      person_sha256: sha256(ottoline),
      thread_sha256: sha256(ours.threadId),
      channel: "linkedin",
      label: "not_positive",
      class_label: "not_now",
      labeled_at: labeledAt,
      received_at: at(-10).toISOString(),
      text: "Yes [first_name] here, Tuesday works",
      opt_out_matched: false,
      classification: null,
      earlier: before.slice(2).map(({ direction, sentBy, body, sentAt }) => ({
        direction,
        sent_by: sentBy ?? null,
        text: body.replace("Ottoline Vashti", "[first_name] [last_name]"),
        at: sentAt.toISOString(),
      })),
    },
  ]);
  for (const value of ["Ottoline", "Vashti", "Bramwell", "Okonkwo", "linkedin.com"]) {
    assert.doesNotMatch(body, new RegExp(value, "i"), value);
  }
  assert.doesNotMatch(body, /\b(?:per|thr|msg|rlb|wsp|usr|sac)_[0-9A-Za-z]/);
  assert.equal(await stored(workspaceId, `w/${workspaceId}/exports/${name}`), body);
});

test("?week: that ISO week's labels only, to reply-labels-<week>.jsonl, the day's full file left in place; refused: a week not started and one its year does not have, 400 week_invalid; a malformed one, 400 validation_failed", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const recent = await labeledReply(a, ["Ottoline", "Vashti"], "positive", 0);
  const older = await labeledReply(a, ["Bramwell", "Okonkwo"], "not_positive", 8 * DAY);

  const full = await exported(a.user.id, workspaceId);
  assert.deepEqual(
    full.lines.map((line) => line.person_sha256),
    [sha256(older.personId), sha256(recent.personId)],
  );
  const now = new Date();
  const week = isoWeek(now);
  const weekly = await exported(a.user.id, workspaceId, `?week=${week}`);
  assert.equal(weekly.res.status, 200);
  assert.equal(fileOf(weekly.res), `reply-labels-${week}.jsonl`);
  assert.deepEqual(
    weekly.lines.map((line) => [line.person_sha256, line.label]),
    [[sha256(recent.personId), "positive"]],
  );
  const folder = `w/${workspaceId}/exports`;
  assert.equal(await stored(workspaceId, `${folder}/reply-labels-${week}.jsonl`), weekly.body);
  const day = `${folder}/${fileOf(full.res)}`;
  assert.equal(await stored(workspaceId, day), full.body, "the day's full file stays");
  const lastWeek = isoWeek(new Date(now.getTime() - 8 * DAY));
  const earlier = await exported(a.user.id, workspaceId, `?week=${lastWeek}`);
  assert.deepEqual(
    earlier.lines.map((line) => [line.person_sha256, line.label]),
    [[sha256(older.personId), "not_positive"]],
  );

  const nextWeek = isoWeek(new Date(now.getTime() + 7 * DAY));
  for (const refused of [nextWeek, "2026-W60", "2025-W53"]) {
    const { res, body } = await exported(a.user.id, workspaceId, `?week=${refused}`);
    assert.deepEqual([res.status, JSON.parse(body)], [400, { code: "week_invalid" }], refused);
  }
  const malformed = await exported(a.user.id, workspaceId, "?week=soon");
  assert.deepEqual(
    [malformed.res.status, JSON.parse(malformed.body)],
    [400, { code: "validation_failed", details: { fields: ["week"] } }],
  );
});

test("the permission: inbox.export, an Owner's or an Admin's file, each their own threads' replies only; a Member refused 403 forbidden, writing nothing; each workspace's its own; another workspace's user refused 403", async () => {
  const [a, b] = await createTwoWorkspaces();
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: a.workspace.id, role: "Member" });
  const admin = await createUser();
  await createMembership({ userId: admin.id, workspaceId: a.workspace.id, role: "Admin" });
  const ours = await labeledReply(a, ["Ottoline", "Vashti"], "positive", 0);
  await labeledReply(a, ["Saoirse", "Delacroix"], "not_positive", 0, member.id);
  const admins = await labeledReply(a, ["Bramwell", "Okonkwo"], "positive", 0, admin.id);
  const theirs = await labeledReply(b, ["Linnea", "Haverkamp"], "not_positive", 0);
  const pairs = (lines: Record<string, any>[]) =>
    lines.map((line) => [line.person_sha256, line.thread_sha256, line.channel]);

  const refused = await exported(member.id, a.workspace.id);
  assert.deepEqual([refused.res.status, JSON.parse(refused.body)], [403, { code: "forbidden" }]);
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const listed = await files.list({ workspaceId: a.workspace.id, prefix: "exports/" });
  assert.deepEqual(listed.files, [], "a refused export writes no file");

  const owners = await exported(a.user.id, a.workspace.id);
  assert.equal(owners.res.status, 200);
  assert.deepEqual(pairs(owners.lines), [
    [sha256(ours.personId), sha256(ours.threadId), "linkedin"],
  ]);
  const adminsFile = await exported(admin.id, a.workspace.id);
  assert.equal(adminsFile.res.status, 200);
  assert.deepEqual(pairs(adminsFile.lines), [
    [sha256(admins.personId), sha256(admins.threadId), "linkedin"],
  ]);
  const other = await exported(b.user.id, b.workspace.id);
  assert.deepEqual(pairs(other.lines), [
    [sha256(theirs.personId), sha256(theirs.threadId), "linkedin"],
  ]);
  const elsewhere = await exported(b.user.id, a.workspace.id);
  assert.deepEqual(
    [elsewhere.res.status, JSON.parse(elsewhere.body)],
    [403, { code: "forbidden" }],
  );
  const handler = ExportsController.prototype.replyLabels;
  assert.equal(Reflect.getMetadata("whytide:permission", handler), "inbox.export");
});
