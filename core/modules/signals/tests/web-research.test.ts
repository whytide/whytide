// A research source in the domain (gamma-wr-030; README.md "API", "Runs", "Settings"), on this file's
// schema: created with no sender account and answered with it null, one given for the kind refused and
// a LinkedIn kind's missing one refused, both naming `senderAccountId`; its config edited and stored, a
// LinkedIn kind's refused, and the write rule unchanged (another member's source is forbidden); it
// counts in SIGNALS_MAX_ENABLED_SOURCES (3 here) and not in SIGNALS_MAX_TRACKED_PER_ACCOUNT (1 here),
// and in no account's share of reads; the tick writes its run only when it is enabled, in an active
// agent, with no run open and none started within the days (every 7, then every 30).
import assert from "node:assert/strict";
import test from "node:test";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.SIGNALS_MAX_ENABLED_SOURCES = "3";
process.env.SIGNALS_MAX_TRACKED_PER_ACCOUNT = "1";
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { createConnectedAccount, useLinkedinClient } = await import("@whytide/linkedin/testing");
const { isAppError, servicePrincipal } = await import("@whytide/platform");
const { createPlaybook } = await import("@whytide/playbooks/testing");
const { readBudgetOf } = await import("../domain/schedule/daily.ts");
const { isResearchDue, writeDueResearchRuns } = await import("../domain/schedule/research.ts");
const { createSource, updateSource } = await import("../domain/sources.ts");
const { createSignalRun, createSignalSource, useSignalsClient } = await import(
  "../testing/index.ts"
);

withTestDb();
const client = asRole("app");
useLinkedinClient(client);
useSignalsClient(client);
const OWNER = "usr_research_owner";
const principal = { ...servicePrincipal("signals_test") };
const member = (workspaceId: string, userId: string) => ({
  workspaceId,
  principal: {
    ...{ userId, actorType: "human" as const, authMethod: "session" as const },
    ...{ membershipId: `mem_${userId}`, role: "Member" as const, scopes: [], workspaceId },
  },
});
const inRun = <T>(workspaceId: string, fn: () => Promise<T>, who = { workspaceId, principal }) =>
  withTenant(who, fn, { client });
const refusal = (error: unknown) =>
  isAppError(error) ? { code: error.code, details: error.details } : error;
const GRAIN = { focus: "traders of grain", languages: ["en"] };
const research = (config: Record<string, unknown> = GRAIN, label = "Grain") => ({
  ...{ kind: "web_research", config, label },
});
const creator = (senderAccountId: string, slug: string) => ({
  kind: "creator_engagement",
  config: { profileUrl: `https://www.linkedin.com/in/${slug}` },
  label: slug,
  senderAccountId,
});
const sourceRows = (workspaceId: string) =>
  client.signalSource.findMany({ where: { workspaceId } });
const published = (workspaceId: string) =>
  client.outboxEntry.count({ where: { workspaceId, eventName: "signals.source_created" } });

test("a research source is created with no sender account, enabled, and answered with it null; one given is refused naming the field, and so is a LinkedIn kind's missing one, nothing stored", async () => {
  const ws = "wsp_research_create";
  const source = await inRun(ws, () => createSource(research()));
  assert.deepEqual(
    [source.kind, source.senderAccountId, source.enabled, source.config],
    ["web_research", null, true, GRAIN],
  );
  assert.equal(await published(ws), 1);
  const { id } = await createConnectedAccount(ws);
  const invalid = {
    code: "signal_sender_account_invalid",
    details: { fields: ["senderAccountId"] },
  };
  const given = inRun(ws, () => createSource({ ...research(), senderAccountId: id }));
  assert.deepEqual(await given.catch(refusal), invalid);
  const { senderAccountId: _none, ...bare } = creator(id, "no-account");
  const missing = inRun(ws, () => createSource(bare));
  assert.deepEqual(await missing.catch(refusal), invalid);
  assert.equal((await sourceRows(ws)).length, 1);
  assert.equal(await published(ws), 1);
  // A bad field is the config's, named.
  const bad = inRun(ws, () => createSource(research({ focus: "ab" })));
  assert.deepEqual(await bad.catch(refusal), {
    code: "signal_config_invalid",
    details: { fields: ["config.focus"] },
  });
});

test("a research source's config is edited and stored, answered as stored; a LinkedIn kind's is refused naming config, an invalid one its field, and another member's source is forbidden", async () => {
  const ws = "wsp_research_edit";
  const mine = member(ws, OWNER);
  const source = await inRun(ws, () => createSource(research()), mine);
  const next = {
    focus: "  brokers of   shipping ",
    region: "the coast",
    startPages: ["https://a.example/x"],
  };
  const edited = await inRun(ws, () => updateSource(source.id, { config: next }), mine);
  assert.deepEqual(edited.config, {
    focus: "brokers of shipping",
    region: "the coast",
    startPages: ["https://a.example/x"],
  });
  const stored = await client.signalSource.findUniqueOrThrow({ where: { id: source.id } });
  assert.deepEqual(stored.config, edited.config);
  assert.equal(stored.label, "Grain", "a config change leaves the label");
  const bad = inRun(ws, () => updateSource(source.id, { config: { focus: "x" } }), mine);
  assert.deepEqual(await bad.catch(refusal), {
    code: "signal_config_invalid",
    details: { fields: ["config.focus"] },
  });
  // Another member's source: forbidden, nothing written.
  const other = member(ws, "usr_research_other");
  const theirs = inRun(ws, () => updateSource(source.id, { config: GRAIN }), other);
  assert.equal(((await theirs.catch(refusal)) as { code: string }).code, "forbidden");
  assert.deepEqual(
    (await client.signalSource.findUniqueOrThrow({ where: { id: source.id } })).config,
    edited.config,
  );
  // A LinkedIn kind's target stays fixed.
  const { id: account } = await createConnectedAccount(ws, { ownerUserId: OWNER });
  const linked = await inRun(ws, () => createSource(creator(account, "creator-a")), mine);
  const target = { profileUrl: "https://www.linkedin.com/in/creator-b" };
  const refused = inRun(ws, () => updateSource(linked.id, { config: target }), mine);
  assert.deepEqual(await refused.catch(refusal), {
    code: "signal_config_invalid",
    details: { fields: ["config"] },
  });
  assert.deepEqual(
    (await client.signalSource.findUniqueOrThrow({ where: { id: linked.id } })).config,
    creator(account, "creator-a").config,
  );
  // Its label and its switch still change, config or none.
  const relabeled = await inRun(ws, () => updateSource(linked.id, { label: "Renamed" }), mine);
  assert.equal(relabeled.label, "Renamed");
});

test("it counts in SIGNALS_MAX_ENABLED_SOURCES with the sources of its group, and not in SIGNALS_MAX_TRACKED_PER_ACCOUNT: with 3 and 1 set, a creator, two research sources fill the group, a fourth is signal_sources_limit, and a second creator is signal_tracked_limit whatever the research sources", async () => {
  const ws = "wsp_research_limits";
  const { id: account } = await createConnectedAccount(ws, { ownerUserId: OWNER });
  const code = (error: unknown) => (refusal(error) as { code: string }).code;
  await inRun(ws, () => createSource(creator(account, "creator-limit")));
  await inRun(ws, () => createSource(research(GRAIN, "One")));
  assert.equal(
    code(await inRun(ws, () => createSource(creator(account, "creator-two"))).catch((e) => e)),
    "signal_tracked_limit",
  );
  await inRun(ws, () => createSource(research(GRAIN, "Two")));
  const over = inRun(ws, () => createSource(research(GRAIN, "Three")));
  assert.deepEqual(await over.catch(refusal), {
    code: "signal_sources_limit",
    details: { limit: 3 },
  });
  // Disabled, one is room again; enabling counts it.
  const rows = await sourceRows(ws);
  const one = rows.find(({ label }) => label === "One");
  assert.ok(one);
  await inRun(ws, () => updateSource(one.id, { enabled: false }));
  await inRun(ws, () => createSource(research(GRAIN, "Three")));
  const enable = inRun(ws, () => updateSource(one.id, { enabled: true }));
  assert.equal(((await enable.catch(refusal)) as { code: string }).code, "signal_sources_limit");
});

test("no account's share of reads counts a research source: the budget of a creator's run is the same with research sources enabled beside it", async () => {
  const ws = "wsp_research_share";
  const { id: account } = await createConnectedAccount(ws, { ownerUserId: OWNER });
  const creatorId = (await inRun(ws, () => createSource(creator(account, "creator-share")))).id;
  const alone = await inRun(ws, () => readBudgetOf(creatorId, account));
  for (const label of ["A", "B"]) await inRun(ws, () => createSource(research(GRAIN, label)));
  const beside = await inRun(ws, () => readBudgetOf(creatorId, account));
  assert.deepEqual(beside, alone);
  assert.ok(alone.readBudget > 0);
});

const NOW = new Date("2026-11-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

test("the due rule: no run open or about to start, none started within the days, whatever started it", () => {
  const run = (status: string, startedAt: Date | null) => ({ status, startedAt });
  assert.equal(isResearchDue([], NOW, 7), true);
  assert.equal(isResearchDue([run("done", ago(8))], NOW, 7), true);
  assert.equal(isResearchDue([run("done", ago(6))], NOW, 7), false);
  assert.equal(isResearchDue([run("failed", ago(1))], NOW, 7), false);
  assert.equal(isResearchDue([run("done", ago(29))], NOW, 30), false);
  assert.equal(isResearchDue([run("done", ago(31))], NOW, 30), true);
  for (const status of ["scheduled", "running", "waiting"]) {
    assert.equal(isResearchDue([run(status, ago(60))], NOW, 7), false, status);
  }
});

test("the tick writes a run for a due research source in an active agent, and none for one in no agent, one with a run within the days, one with a run open, a disabled one or a paused agent's; a source of another workspace gets none from this workspace's tick", async () => {
  const ws = "wsp_research_tick";
  const source = (label: string, enabled = true) =>
    createSignalSource({
      ...{ workspaceId: ws, label, kind: "web_research", config: GRAIN },
      ...{ senderAccountId: null, createdBy: OWNER },
    }).then(async (row) => {
      if (!enabled) await client.signalSource.update({ where: { id: row.id }, data: { enabled } });
      return row.id;
    });
  const [due, noAgent, recent, open, disabled, paused, old] = [
    await source("due"),
    await source("no agent"),
    await source("recent"),
    await source("open"),
    await source("disabled", false),
    await source("paused"),
    await source("old"),
  ];
  const agent = (icpId: string, sourceIds: string[], status?: "paused") =>
    createPlaybook({ ...{ workspaceId: ws, icpId, ownerUserId: OWNER }, sourceIds, status });
  await agent("icp_active", [due, recent, open, disabled, old]);
  await agent("icp_paused", [paused], "paused");
  const run = (sourceId: string, status: "done" | "running", startedAt: Date) =>
    createSignalRun({ workspaceId: ws, sourceId, status, startedAt });
  await run(recent, "done", ago(2));
  await run(open, "running", ago(40));
  await run(old, "done", ago(9));
  await run(due, "done", ago(30));
  const written = await inRun(ws, () => writeDueResearchRuns(NOW));
  assert.equal(written, 2);
  const scheduled = await client.signalRun.findMany({
    where: { workspaceId: ws, status: "scheduled" },
  });
  assert.deepEqual(scheduled.map(({ sourceId }) => sourceId).sort(), [due, old].sort());
  assert.ok(
    ![noAgent, recent, open, disabled, paused].some((id) =>
      scheduled.some((r) => r.sourceId === id),
    ),
  );
  const requested = await client.outboxEntry.count({
    where: { workspaceId: ws, eventName: "signals.run_requested" },
  });
  assert.equal(requested, 2);
  // A second tick writes none: the two runs are about to start.
  assert.equal(await inRun(ws, () => writeDueResearchRuns(NOW)), 0);
  // Another workspace's tick sees none of this workspace's sources.
  assert.equal(await inRun("wsp_research_tick_other", () => writeDueResearchRuns(NOW)), 0);
});
