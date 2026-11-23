// contacts' batched commands (alpha-p10-080; domain/batch.ts) on the worktree's database, in this
// file's schema: a chunk of inputs written by upsertPersonsFromSource and createLeadsForPersons
// leaves the rows and answers that upsertPersonFromSource and createLeadForPerson leave input by
// input, in a workspace of its own; a person another run creates meanwhile is merged, not
// overwritten; and each run writes its own workspace only.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { createLeadsForPersons, upsertPersonsFromSource } from "../domain/batch.ts";
import { recordHash } from "../domain/hashes.ts";
import { createLeadForPerson } from "../domain/leads.ts";
import { type PersonFromSource, upsertPersonFromSource } from "../domain/persons.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const principal = servicePrincipal("contacts_test");
const run = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T08:00:00Z`);
const url = (slug: string) => `https://linkedin.com/in/${slug}`;
const imported = (profile: PersonFromSource["profile"]): PersonFromSource => ({
  source: "import",
  provider: "csv",
  profile: { fetchedAt: at(10), ...profile },
});

/** What a workspace holds before the chunk: a person a signal found, its lead, and an erasure. */
async function before(workspaceId: string) {
  await run(workspaceId, async () => {
    const profile = {
      linkedinUrl: url("stored-lead"),
      providerId: "synthetic-member-7",
      firstName: "Stored",
      title: "Head of Data",
      headline: "Builds data teams",
      fetchedAt: at(12),
    };
    const { person } = await upsertPersonFromSource({
      source: "linkedin",
      provider: "unipile",
      profile,
    });
    await createLeadForPerson({
      personId: person.id,
      source: { kind: "signal", ref: "sig_1", at: at(12) },
    });
    await recordHash({ linkedinUrl: url("erased-one"), kind: "erased" });
  });
}

/** The chunk: new, stored (older values and newer ones), erased, refused, and a URL twice. */
const CHUNK: PersonFromSource[] = [
  imported({ linkedinUrl: url("new-one"), name: "Ada Lovelace", companyName: "Blue Harbor Labs" }),
  imported({
    linkedinUrl: "https://www.linkedin.com/in/Stored-Lead/",
    title: "VP Data",
    locationText: "Lisbon, Portugal",
    fetchedAt: at(11),
  }),
  imported({ linkedinUrl: url("erased-one"), name: "Gone Person" }),
  imported({ linkedinUrl: "https://example.com/in/not-linkedin" }),
  imported({ linkedinUrl: url("too-long"), title: "x".repeat(301) }),
  imported({
    linkedinUrl: url("stored-lead"),
    companyName: "Kestrel Analytics",
    fetchedAt: at(13),
  }),
  imported({ linkedinUrl: url("new-one"), title: "Head of Data", fetchedAt: at(14) }),
];
/** A signal source's label and URL, as signals gives them. */
const NAMED = { at: at(16), label: "Launch post", url: "https://posts.example/launch" };
const LEADS = (personIds: readonly string[]) => [
  ...personIds.map((personId) => ({
    personId,
    source: { kind: "imported" as const, ref: "imp_1", at: at(10) },
  })),
  // Once more with the same source, which it has, and with another job's.
  { personId: personIds[0] ?? "", source: { kind: "imported" as const, ref: "imp_1", at: at(15) } },
  { personId: personIds[1] ?? "", source: { kind: "imported" as const, ref: "imp_2", at: at(15) } },
  // The stored lead's signal source again, named now: its entry takes the label and the URL.
  { personId: personIds[1] ?? "", source: { kind: "signal" as const, ref: "sig_1", ...NAMED } },
];

/**
 * A row without what differs between two workspaces: the id, the workspace and the times, the
 * enrichment hold's among them (enrichment-hold.test.ts proves each command sets it).
 */
function comparable(row: Record<string, unknown>) {
  const {
    id: _id,
    personId: _person,
    workspaceId: _ws,
    createdAt: _c,
    updatedAt: _u,
    enrichmentHoldUntil: _hold,
    ...rest
  } = row;
  return rest;
}
const answerOf = (
  answer: { person: Record<string, unknown>; created: boolean } | { code: string },
) => ("code" in answer ? answer : { created: answer.created, person: comparable(answer.person) });

test("a chunk through the batched commands leaves the rows and the answers of the one-row commands, input by input", async () => {
  await before("wsp_batch_one");
  await before("wsp_batch_many");
  const one = await run("wsp_batch_one", async () => {
    const answers = [];
    for (const input of CHUNK) {
      try {
        answers.push(await upsertPersonFromSource(input));
      } catch (error) {
        if (!isAppError(error)) throw error;
        answers.push({ code: error.code });
      }
    }
    const personIds = [...new Set(answers.flatMap((a) => ("person" in a ? [a.person.id] : [])))];
    const leads = [];
    for (const input of LEADS(personIds)) leads.push(await createLeadForPerson(input));
    return { answers, leads };
  });
  const many = await run("wsp_batch_many", async () => {
    const answers = await upsertPersonsFromSource(CHUNK);
    const personIds = [...new Set(answers.flatMap((a) => ("person" in a ? [a.person.id] : [])))];
    return { answers, leads: await createLeadsForPersons(LEADS(personIds)) };
  });

  const codes = many.answers.map((answer) => ("code" in answer ? answer.code : "written"));
  assert.deepEqual(codes, [
    "written",
    "written",
    "person_erased",
    "linkedin_url_invalid",
    "contacts_input_invalid",
    "written",
    "written",
  ]);
  // A URL twice (0 and 6, 1 and 5): the one-row command answers each step, the chunk the person
  // it leaves.
  for (const index of [2, 3, 4, 5, 6]) {
    const [ours, theirs] = [many.answers[index], one.answers[index]];
    assert.deepEqual(answerOf(ours as never), answerOf(theirs as never), `input ${index}`);
  }
  assert.deepEqual(
    many.answers.map((answer) => ("created" in answer ? answer.created : null)),
    one.answers.map((answer) => ("created" in answer ? answer.created : null)),
  );
  const personOf = (answer: unknown) => (answerOf(answer as never) as { person: unknown }).person;
  assert.deepEqual(personOf(many.answers[0]), personOf(one.answers[6]));
  assert.deepEqual(personOf(many.answers[1]), personOf(one.answers[5]));

  const app = asRole("app");
  const rows = async (workspaceId: string) => ({
    persons: (
      await app.person.findMany({ where: { workspaceId }, orderBy: { linkedinUrl: "asc" } })
    ).map(comparable),
    leads: (
      await app.lead.findMany({ where: { workspaceId }, orderBy: { firstSourceAt: "asc" } })
    ).map(comparable),
  });
  const [ours, theirs] = await Promise.all([rows("wsp_batch_many"), rows("wsp_batch_one")]);
  assert.equal(ours.persons.length, 2);
  assert.deepEqual(ours, theirs);
  const stored = ours.persons.find((person) => person.linkedinUrl === url("stored-lead"));
  // The import's older title loses to the signal's; its location and newer company win.
  assert.deepEqual(
    [stored?.title, stored?.companyName, stored?.locationCountry, stored?.providerRefs],
    ["Head of Data", "Kestrel Analytics", "PT", { unipile: "synthetic-member-7" }],
  );
  assert.deepEqual(
    many.leads.map(({ created }) => created),
    one.leads.map(({ created }) => created),
  );
  const refs = ["sig_1", "imp_1", "imp_2"];
  assert.deepEqual(
    many.leads.map(({ lead }) => lead.sources.map((source) => source.ref)),
    [["imp_1"], refs, ["imp_1"], refs, refs],
  );
  const named = { label: NAMED.label, url: NAMED.url };
  const signal = { kind: "signal", ref: "sig_1", at: at(12).toISOString(), ...named };
  assert.deepEqual(many.leads.at(-1)?.lead.sources[0], signal);
});

test("a person another run creates with a URL of the chunk, after the chunk's read, is merged: neither run's values are lost", async () => {
  const workspaceId = "wsp_batch_race";
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let wrote = () => {};
  const written = new Promise<void>((resolve) => {
    wrote = resolve;
  });
  const profile = { linkedinUrl: url("raced"), headline: "Runs the data team", fetchedAt: at(9) };
  const other = run(workspaceId, async () => {
    await upsertPersonFromSource({ source: "linkedin", provider: "unipile", profile });
    wrote();
    await held;
  });
  await written;
  const chunk = run(workspaceId, () =>
    upsertPersonsFromSource([imported({ linkedinUrl: url("raced"), companyName: "Kestrel" })]),
  );
  // The chunk reads before the other run commits, then waits on its row at the insert.
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  await other;
  const [answer] = await chunk;
  assert.ok(answer && "person" in answer);
  assert.deepEqual(
    [answer.created, answer.person.headline, answer.person.companyName],
    [false, "Runs the data team", "Kestrel"],
  );
  assert.equal(await asRole("app").person.count({ where: { workspaceId } }), 1);
});

test("each run writes its own workspace only: the same URL is two persons; another workspace's person is person_not_found and nothing is written", async () => {
  const chunk = [imported({ linkedinUrl: url("twice"), name: "Twice Over" })];
  const [a] = await run("wsp_batch_a", () => upsertPersonsFromSource(chunk));
  const [b] = await run("wsp_batch_b", () => upsertPersonsFromSource(chunk));
  assert.ok(a && "person" in a && b && "person" in b);
  assert.notEqual(a.person.id, b.person.id);
  assert.deepEqual([a.person.workspaceId, b.person.workspaceId], ["wsp_batch_a", "wsp_batch_b"]);
  const source = { kind: "imported", ref: "imp_1" } as const;
  await assert.rejects(
    run("wsp_batch_b", () =>
      createLeadsForPersons([
        { personId: b.person.id, source },
        { personId: a.person.id, source },
      ]),
    ),
    { code: "person_not_found" },
  );
  assert.equal(await asRole("app").lead.count(), 0);
  const [lead] = await run("wsp_batch_a", () =>
    createLeadsForPersons([{ personId: a.person.id, source }]),
  );
  assert.deepEqual([lead?.created, lead?.lead.workspaceId], [true, "wsp_batch_a"]);
});
