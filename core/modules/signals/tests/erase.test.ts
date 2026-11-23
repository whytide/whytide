// The erasure's scrub (gamma-p5-020; README.md "Reduction"), against the worktree's database:
// erasePerson, which the deletion script calls before contacts' own, reads the person's public id from
// contacts' person and removes it where signals names them. Each post engagers source on their posts is
// disabled, its open runs stopped as Stop stops them, its URL and label emptied; other people's
// evidence whose /posts/ URL names them as the post's author gets the unnamed URL and loses the post's
// excerpt. A URL naming someone else, an unnamed URL and a person gone from contacts are left alone.
// Each creator source on their profile is disabled the same way (gamma-p5-025); a competitor's page
// names no person. The decision record a rated event names goes with it, though its subject is
// the source (gamma-p5-030); every triage record of the workspace, its subject, goes with anyone
// (signals-triage-ai). A person without a LinkedIn profile (gamma-rf-050) has no public id: their own
// events go, and nothing is scrubbed.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { erasePerson } from "../domain/evidence.ts";
import { ids } from "../ids.ts";
import { createSignalEvent, createSignalRun, createSignalSource } from "../testing/index.ts";

withTestDb();
const client = asRole("app");
const principal = servicePrincipal("signals_test");
const erase = (workspaceId: string, personId: string) =>
  withTenant({ workspaceId, principal }, () => erasePerson(personId), { client });
const ID = "7250000000000000000";
const UNNAMED = `https://www.linkedin.com/feed/update/urn:li:activity:${ID}`;
const named = (author: string, kind = "activity") =>
  `https://www.linkedin.com/posts/${author}_launch-day-${kind}-${ID}-AbCd`;
const occurredAt = new Date("2026-10-21T10:00:00.000Z");
/** What an erase of no one signals holds deletes. */
const NONE = { signal_events: 0, evidence: 0, decision_records: 0 };

/** A person in contacts, as erasePerson finds them before contacts' own erasure; null: no profile. */
const person = (workspaceId: string, id: string, linkedinUrl: string | null) =>
  client.person.create({ data: { id, workspaceId, linkedinUrl, fieldProvenance: {} } });
/** Someone else's comment on the post at `url`, with the post's excerpt. */
const comment = (workspaceId: string, url: string) =>
  createSignalEvent({
    workspaceId,
    personId: "per_reader",
    url,
    postExcerpt: "The author's words",
    commentText: "Congrats",
    occurredAt,
  });
/** What signals holds of the workspace, as a second erase must leave it. */
async function snapshot(workspaceId: string) {
  const where = { workspaceId };
  const orderBy = { id: "asc" } as const;
  return {
    sources: await client.signalSource.findMany({ where, orderBy }),
    runs: await client.signalRun.findMany({ where, orderBy }),
    events: await client.signalEvent.findMany({ where, orderBy }),
    evidence: await client.evidence.findMany({ where, orderBy }),
    outbox: await client.outboxEntry.count({ where }),
  };
}

test("erasing a person disables the post engagers sources on their posts, stops their open runs and leaves their URL nowhere in signal_sources; others' evidence on their posts gets the unnamed URL without the post's excerpt; a second erase changes nothing", async () => {
  const workspaceId = "wsp_scrub";
  await person(workspaceId, "per_jane", "https://linkedin.com/in/jane-doe");
  const source = (label: string, postUrl: string) =>
    createSignalSource({ workspaceId, label, postUrl });
  const theirs = await source("Jane's launch", named("jane-doe"));
  const upper = await source("Jane's hiring post", named("Jane-Doe", "ugcPost"));
  const others = await source("Someone else's post", named("jane-doe-smith"));
  const feed = await source("An unnamed post", UNNAMED);
  const run = (sourceId: string, status: "running" | "waiting" | "done") =>
    createSignalRun({ workspaceId, sourceId, status, startedAt: occurredAt });
  const running = await run(theirs.id, "running");
  const done = await run(theirs.id, "done");
  const waiting = await run(upper.id, "waiting");
  const onTheirs = await comment(workspaceId, named("jane-doe"));
  const onUpper = await comment(workspaceId, named("JANE-DOE", "share"));
  const onOthers = await comment(workspaceId, named("jane-doe-smith"));
  const onFeed = await comment(workspaceId, UNNAMED);
  await createSignalEvent({ workspaceId, personId: "per_jane", url: named("someone") });

  const counts = { ...NONE, signal_events: 1, evidence: 1 };
  assert.deepEqual(await erase(workspaceId, "per_jane"), counts);
  const after = await snapshot(workspaceId);
  const sourceOf = (id: string) => {
    const row = after.sources.find((one) => one.id === id);
    return row && { enabled: row.enabled, config: row.config, label: row.label };
  };
  const scrubbed = { enabled: false, config: { postUrl: "" }, label: "" };
  assert.deepEqual([sourceOf(theirs.id), sourceOf(upper.id)], [scrubbed, scrubbed]);
  assert.deepEqual(sourceOf(others.id), {
    enabled: true,
    config: others.config,
    label: others.label,
  });
  assert.deepEqual(sourceOf(feed.id), {
    enabled: true,
    config: { postUrl: UNNAMED },
    label: feed.label,
  });
  assert.doesNotMatch(JSON.stringify(after.sources), /jane-doe_|Jane's/i);
  const stopped = after.runs.filter((one) => one.stopRequestedAt !== null).map(({ id }) => id);
  assert.deepEqual(stopped.sort(), [running.id, waiting.id].sort());
  assert.ok(after.runs.some((one) => one.id === done.id && one.status === "done"));
  const published = await client.outboxEntry.findMany({
    where: { workspaceId },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    published.map(({ eventName, payload }) => [eventName, payload]),
    [
      ["signals.source_updated", { source_id: theirs.id }],
      ["signals.run_stop_requested", { source_id: theirs.id, run_id: running.id }],
      ["signals.source_updated", { source_id: upper.id }],
      ["signals.run_stop_requested", { source_id: upper.id, run_id: waiting.id }],
    ],
  );
  const evidenceOf = (eventId: string) => {
    const row = after.evidence.find((one) => one.eventId === eventId);
    return (
      row && [row.url, row.postExcerpt, row.excerpt, row.reaction, row.capturedAt.toISOString()]
    );
  };
  const kept = ["Congrats", "comment", occurredAt.toISOString()];
  assert.deepEqual(evidenceOf(onTheirs.id), [UNNAMED, null, ...kept]);
  assert.deepEqual(evidenceOf(onUpper.id), [UNNAMED.replace("activity", "share"), null, ...kept]);
  assert.deepEqual(evidenceOf(onOthers.id), [
    named("jane-doe-smith"),
    "The author's words",
    ...kept,
  ]);
  assert.deepEqual(evidenceOf(onFeed.id), [UNNAMED, "The author's words", ...kept]);
  const events = after.events.map(({ id, personId, occurredAt: at }) => [
    id,
    personId,
    at.getTime(),
  ]);
  const reader = (event: { id: string }) => [event.id, "per_reader", occurredAt.getTime()];
  assert.deepEqual(events, [onTheirs, onUpper, onOthers, onFeed].map(reader));

  assert.deepEqual(await erase(workspaceId, "per_jane"), NONE);
  assert.deepEqual(await snapshot(workspaceId), after);
});

test("a public id percent-encoded in contacts matches a /posts/ URL however it is written; a person gone from contacts scrubs nothing", async () => {
  const workspaceId = "wsp_scrub_encoded";
  await person(workspaceId, "per_jurgen", "https://linkedin.com/in/j%c3%bcrgen-m");
  const encoded = await comment(workspaceId, named("J%C3%BCrgen-M"));
  const written = await comment(workspaceId, named("Jürgen-M", "share"));
  const gone = await comment(workspaceId, named("gone-person"));
  const source = await createSignalSource({
    workspaceId,
    label: "Gone",
    postUrl: named("gone-person"),
  });
  await erase(workspaceId, "per_jurgen");
  await erase(workspaceId, "per_gone");
  const rows = await client.evidence.findMany({ where: { workspaceId } });
  const urlOf = (eventId: string) => rows.find((row) => row.eventId === eventId)?.url;
  assert.deepEqual(
    [urlOf(encoded.id), urlOf(written.id), urlOf(gone.id)],
    [UNNAMED, UNNAMED.replace("activity", "share"), named("gone-person")],
  );
  const left = await client.signalSource.findFirstOrThrow({ where: { id: source.id } });
  assert.deepEqual([left.enabled, left.config, left.label], [true, source.config, "Gone"]);
});

test("erasing a person disables the creator sources on their profile, however it is written, stops their open runs and leaves their URL nowhere in signal_sources; a creator source on someone else and a competitor's page are kept; a second erase changes nothing", async () => {
  const workspaceId = "wsp_scrub_creator";
  await person(workspaceId, "per_jane", "https://linkedin.com/in/jane-doe");
  const source = (label: string, kind: string, config: Record<string, string>) =>
    client.signalSource.create({
      data: {
        ...{ id: newId(ids.signal_source), workspaceId, kind, config, label },
        ...{ senderAccountId: "sac_test", createdBy: "usr_test" },
      },
    });
  const creator = (label: string, profileUrl: string) =>
    source(label, "creator_engagement", { profileUrl });
  const theirs = await creator("Jane Doe's posts", "https://www.linkedin.com/in/jane-doe");
  const upper = await creator("Jane again", "https://www.linkedin.com/in/Jane-Doe");
  const others = await creator("Someone else", "https://www.linkedin.com/in/jane-doe-smith");
  const page = { companyUrl: "https://www.linkedin.com/company/jane-doe", companyName: "Jane Doe" };
  const company = await source("A page", "competitor_engagement", page);
  const run = (status: "running" | "done") =>
    createSignalRun({ workspaceId, sourceId: theirs.id, status, startedAt: occurredAt });
  const running = await run("running");
  const done = await run("done");

  assert.deepEqual(await erase(workspaceId, "per_jane"), NONE);
  const after = await snapshot(workspaceId);
  const rowOf = (id: string) => {
    const row = after.sources.find((one) => one.id === id);
    return row && { enabled: row.enabled, config: row.config, label: row.label };
  };
  const scrubbed = { enabled: false, config: { profileUrl: "" }, label: "" };
  assert.deepEqual([rowOf(theirs.id), rowOf(upper.id)], [scrubbed, scrubbed]);
  for (const kept of [others, company]) {
    assert.deepEqual(rowOf(kept.id), { enabled: true, config: kept.config, label: kept.label });
  }
  assert.doesNotMatch(JSON.stringify(after.sources), /\/in\/jane-doe"|Jane Doe's|Jane again/i);
  const stopped = after.runs.filter((one) => one.stopRequestedAt !== null).map(({ id }) => id);
  assert.deepEqual(stopped, [running.id]);
  assert.ok(after.runs.some((one) => one.id === done.id && one.status === "done"));
  const published = await client.outboxEntry.findMany({
    where: { workspaceId },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    published.map(({ eventName, payload }) => [eventName, payload]),
    [
      ["signals.source_updated", { source_id: theirs.id }],
      ["signals.run_stop_requested", { source_id: theirs.id, run_id: running.id }],
      ["signals.source_updated", { source_id: upper.id }],
    ],
  );

  assert.deepEqual(await erase(workspaceId, "per_jane"), NONE);
  assert.deepEqual(await snapshot(workspaceId), after);
});

test("erasing a rated person deletes the decision record of their batch, which the batch's other events keep naming, and no other record; a second erase changes nothing", async () => {
  const workspaceId = "wsp_scrub_rated";
  const record = (name: string) =>
    client.decisionRecord.create({
      data: {
        ...{ id: `dec_${name}`, workspaceId, task: "signals.rate-engagement" },
        ...{ subjectRef: "sig_rated", modelId: "fake-model", promptVersion: 1, inputHash: name },
        ...{ status: "ok", output: { ratings: [] }, gates: [], latencyMs: 1, attempts: 1 },
        ...{ inputTokens: 1, outputTokens: 1, costCredits: 0, rawPrompt: "Jane: How much?" },
        rawPurgeAfter: new Date(Date.now() + 86_400_000),
      },
    });
  const batch = await record("batch");
  const other = await record("other");
  const rating = { relevance: 0.9, intentClass: "pain_or_complaint", rationale: "Asks the price" };
  const rated = async (personId: string, commentText: string, decisionRecordId: string) => {
    const event = await createSignalEvent({ workspaceId, personId, commentText, rating });
    await client.signalEvent.update({ where: { id: event.id }, data: { decisionRecordId } });
    return event;
  };
  await rated("per_jane", "How much?", batch.id);
  const reader = await rated("per_reader", "Same here", batch.id);
  const elsewhere = await rated("per_reader", "Congrats", other.id);

  const counts = { signal_events: 1, evidence: 1, decision_records: 1 };
  assert.deepEqual(await erase(workspaceId, "per_jane"), counts);
  const records = await client.decisionRecord.findMany({ where: { workspaceId } });
  assert.deepEqual(
    records.map(({ id }) => id),
    [other.id],
  );
  const left = await client.signalEvent.findMany({ where: { workspaceId } });
  const pointers = Object.fromEntries(left.map((event) => [event.id, event.decisionRecordId]));
  assert.deepEqual(pointers, { [reader.id]: batch.id, [elsewhere.id]: other.id });
  assert.deepEqual(await erase(workspaceId, "per_jane"), NONE);
});

test("erasing a person deletes every triage record of the workspace, whose raw prompts hold the batches' headlines, and no record of another subject or workspace; a second erase changes nothing (signals-triage-ai)", async () => {
  const workspaceId = "wsp_scrub_triaged";
  const record = (id: string, workspace: string, task: string, subjectRef: string) =>
    client.decisionRecord.create({
      data: {
        ...{ id, workspaceId: workspace, task, subjectRef, inputHash: id },
        ...{ modelId: "fake-model", promptVersion: 1, status: "ok", output: { decisions: [] } },
        ...{ gates: [], latencyMs: 1, attempts: 1, inputTokens: 1, outputTokens: 1 },
        ...{ costCredits: 0, rawPrompt: '{"headline":"Technical Recruiter at Initech"}' },
        rawPurgeAfter: new Date(Date.now() + 86_400_000),
      },
    });
  const TRIAGE = "signals.triage-engagers";
  await record("dec_triage_one", workspaceId, TRIAGE, workspaceId);
  await record("dec_triage_two", workspaceId, TRIAGE, workspaceId);
  await record("dec_rating", workspaceId, "signals.rate-engagement", "src_kept");
  await record("dec_elsewhere", "wsp_scrub_other", TRIAGE, "wsp_scrub_other");

  assert.deepEqual(await erase(workspaceId, "per_jane"), { ...NONE, decision_records: 2 });
  const left = await client.decisionRecord.findMany({ orderBy: { id: "asc" } });
  assert.deepEqual(
    left.map(({ id }) => id),
    ["dec_elsewhere", "dec_rating"],
  );
  assert.deepEqual(await erase(workspaceId, "per_jane"), NONE);
});

test("erasing a person without a LinkedIn profile deletes their own events and scrubs nothing: no source and no one else's evidence names them (gamma-rf-050)", async () => {
  const workspaceId = "wsp_scrub_no_profile";
  await person(workspaceId, "per_ines", null);
  await createSignalEvent({
    workspaceId,
    personId: "per_ines",
    commentText: "How much?",
    occurredAt,
  });
  const others = await comment(workspaceId, named("ines-q"));
  const source = await createSignalSource({
    workspaceId,
    label: "Ines Q",
    postUrl: named("ines-q"),
  });

  assert.deepEqual(await erase(workspaceId, "per_ines"), {
    ...NONE,
    signal_events: 1,
    evidence: 1,
  });
  const left = await client.evidence.findMany({ where: { workspaceId } });
  assert.deepEqual(
    left.map(({ eventId, url, postExcerpt }) => [eventId, url, postExcerpt]),
    [[others.id, named("ines-q"), "The author's words"]],
  );
  const kept = await client.signalSource.findFirstOrThrow({ where: { id: source.id } });
  assert.deepEqual([kept.enabled, kept.config, kept.label], [true, source.config, "Ines Q"]);
  assert.deepEqual(await erase(workspaceId, "per_ines"), NONE);
});
