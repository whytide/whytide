// The draft of the ICP (icp-draft; README "The draft", "The script") on the worktree's database: the
// request's run, then `pnpm icp:draft` end to end, the test playing the worker by writing the draft
// as the drafter leaves it; with --icp, another audience than the default (gamma-p3-020). The
// drafter itself runs in the worker's tests/icp-draft.test.ts, on the LLM fake, with its workflow.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { runDraft } from "../cli/draft.ts";
import { createAudience } from "../domain/commands.ts";
import { discardDraft, requestDraft } from "../domain/draft.ts";
import { draftStart } from "../events.ts";

withTestDb();
useTenancyClient(asRole("app"));
const principal = servicePrincipal("icp_test");
const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const codeOf = (error: unknown) => (isAppError(error) ? error.code : error);
const outbox = (workspaceId: string, eventName: string) =>
  run(workspaceId, (tx) => tx.outboxEntry.findMany({ where: { eventName } }));

/** What a good model proposes: the drafter's pending draft carries it. */
const PROPOSAL = {
  name: "Bakery owners",
  titles: ["Owner", "Head of Finance"],
  seniorities: ["owner_founder", "head"],
  industries: ["Food and beverage"],
  sizeRanges: ["11-50"],
  countries: ["FR", "BE"],
  mustHaves: "Runs two bakeries or more",
  disqualifiers: "",
};

test("the request: drafting under a new run with the brief and icp.draft_requested, ids only, in one transaction, the version kept; the workflow's id is the run's; no source is icp_draft_no_source", async () => {
  const ws = "wsp_draft_request";
  const refused = await run(ws, () => requestDraft(ws, "  \n ")).catch(codeOf);
  assert.equal(refused, "icp_draft_no_source");
  const long = await run(ws, () => requestDraft(ws, "b".repeat(2001))).catch(codeOf);
  assert.equal(long, "icp_draft_brief_too_long");
  const rollback = new Error("after the request");
  const thrown = run(ws, async () => {
    await requestDraft(ws, "Bakeries in France");
    throw rollback;
  });
  await assert.rejects(thrown, (error) => error === rollback);
  assert.deepEqual(await outbox(ws, "icp.draft_requested"), [], "the event went with the run");
  assert.equal(await run(ws, (tx) => tx.icp.count()), 0, "nothing written");

  const draftRunId = await run(ws, () => requestDraft(ws, "  Bakeries in France \n"));
  assert.match(draftRunId, /^idrun_[0-9A-Z]{26}$/);
  const icp = await run(ws, (tx) => tx.icp.findFirstOrThrow({}));
  assert.deepEqual(
    [icp.draftStatus, icp.draftRunId, icp.draftBrief, icp.pendingDraft, icp.version],
    ["drafting", draftRunId, "Bakeries in France", null, 1],
  );
  const [event, ...more] = await outbox(ws, "icp.draft_requested");
  assert.equal(more.length, 0);
  const ids = { workspaceId: ws, icpId: icp.id, draftRunId };
  assert.deepEqual(event?.payload, ids);
  const workflowId = `icp.draft:${ws}:${draftRunId}`;
  assert.deepEqual(draftStart(ids), { workflow: "icp_draft_profile", input: ids, workflowId });
  assert.deepEqual(await outbox(ws, "icp.updated"), []);
});

test("pnpm icp:draft: --dry-run prints the proposal and saves nothing; a save moves the version and publishes icp.updated once; icp_not_empty without --replace, before the request and, a screen save meanwhile kept, before the save; no draft in time exits 5", async () => {
  const [{ workspace: a }, { workspace: b }] = await createTwoWorkspaces();
  const knowledge = {
    workspaceId: a.id,
    oneLiner: "Bookkeeping for bakeries",
    products: ["Ledger"],
  };
  await run(a.id, (tx) => tx.companyKnowledge.create({ data: { id: "ck_a", ...knowledge } }));
  const lines: string[] = [];
  /** The worker's part, between two reads: the run drafted, as the drafter leaves it. */
  const draftedIn = (workspaceId: string) => async () => {
    const pendingDraft = { model: "fake-model", promptVersion: 1, decisionRecordId: "dec_a" };
    const data = { draftStatus: "drafted", pendingDraft: { ...pendingDraft, fields: PROPOSAL } };
    await run(workspaceId, (tx) => tx.icp.updateMany({ data }));
  };
  const drafted = draftedIn(a.id);
  const draft = (args: string[], wait = drafted, timeoutMs = 10_000) => {
    lines.length = 0;
    const options = { client: asRole("app"), pollMs: 1, timeoutMs, wait };
    return runDraft(args, (line) => lines.push(line), options);
  };
  const stored = () => run(a.id, (tx) => tx.icp.findFirstOrThrow({}));

  assert.equal(await draft(["--workspace", a.id, "--dry-run"]), 0);
  assert.match(lines[0] ?? "", new RegExp(`^icp_draft_requested: idrun_\\w+ in ${a.id}$`));
  assert.deepEqual(lines.slice(2), [
    "name: Bakery owners",
    "titles: Owner, Head of Finance",
    "seniorities: owner_founder, head",
    "industries: Food and beverage",
    "sizeRanges: 11-50",
    "countries: FR, BE",
    "mustHaves: Runs two bakeries or more",
    "disqualifiers: ",
    "icp_draft_not_saved: --dry-run",
  ]);
  assert.deepEqual([(await stored()).version, (await stored()).titles], [1, []]);

  assert.equal(await draft(["--workspace", a.slug]), 0);
  const credits = "at 0.2 credit a lead";
  assert.equal(
    lines.at(-1),
    `icp_saved: version 2; icp.updated re-scores the workspace's leads ${credits}`,
  );
  const saved = await stored();
  assert.deepEqual(
    [saved.version, saved.titles, saved.countries],
    [2, PROPOSAL.titles, ["BE", "FR"]],
  );
  const updated = await outbox(a.id, "icp.updated");
  assert.deepEqual(
    updated.map((entry) => entry.payload),
    [{ workspaceId: a.id, version: 2 }],
  );

  assert.equal(await draft(["--workspace", a.id]), 1);
  assert.match(lines[0] ?? "", /^icp_not_empty: the ICP of wsp_\w+ has targeting: pass --replace/);
  assert.equal((await outbox(a.id, "icp.draft_requested")).length, 2, "no third request");

  const none = async () => undefined;
  assert.equal(await draft(["--workspace", b.id, "--brief", "Bakeries in France"], none, 0), 5);
  assert.equal(
    lines.at(-1),
    "icp_draft_timed_out: no draft after 0 seconds: is the worker running?",
  );
  assert.equal(await draft(["--brief", "x"]), 2);
  assert.equal(await draft(["--workspace", b.id, "--brief-file", "/no/such/brief.txt"]), 1);
  assert.equal(lines.at(-1), "brief_file_unreadable: /no/such/brief.txt");

  // A screen save while the worker drafts: the check before the save, the row locked, refuses.
  const screenSave = async () => {
    await draftedIn(b.id)();
    await run(b.id, (tx) => tx.icp.updateMany({ data: { titles: ["Owner"] } }));
  };
  assert.equal(await draft(["--workspace", b.id, "--brief", "Bakeries"], screenSave), 1);
  assert.match(lines.at(-1) ?? "", /^icp_not_empty: the ICP of wsp_\w+ has targeting/);
  const kept = await run(b.id, (tx) => tx.icp.findFirstOrThrow({}));
  assert.deepEqual([kept.titles, kept.version], [["Owner"], 1]);
  assert.equal(await draft(["--workspace", "no-such-slug"]), 1);
  assert.equal(
    lines.at(-1),
    "workspace_not_found: no single workspace is no-such-slug: pass its id",
  );
});

test("pnpm icp:draft: a draft used or discarded on the ICP screen between two reads exits 6 icp_draft_ended, nothing saved", async () => {
  const [{ workspace }] = await createTwoWorkspaces();
  const ws = workspace.id;
  /** The worker drafts, then the screen's Discard ends the draft before the script's next read. */
  const discarded = async () => {
    const pendingDraft = { model: "fake-model", promptVersion: 1, decisionRecordId: "dec_b" };
    const data = { draftStatus: "drafted", pendingDraft: { ...pendingDraft, fields: PROPOSAL } };
    await run(ws, (tx) => tx.icp.updateMany({ data }));
    await run(ws, () => discardDraft());
  };
  const lines: string[] = [];
  const options = { client: asRole("app"), pollMs: 1, timeoutMs: 10_000, wait: discarded };
  const args = ["--workspace", ws, "--brief", "Bakeries in France"];
  assert.equal(await runDraft(args, (line) => lines.push(line), options), 6);
  assert.match(
    lines.at(-1) ?? "",
    /^icp_draft_ended: the draft of idrun_\w+ was used or discarded on the ICP screen$/,
  );
  const icp = await run(ws, (tx) => tx.icp.findFirstOrThrow({}));
  assert.deepEqual([icp.draftStatus, icp.version, icp.titles], ["none", 1, []]);
  assert.deepEqual(await outbox(ws, "icp.updated"), []);
});

test("pnpm icp:draft --icp: drafts and saves that audience alone, icp.audience_updated and no icp.updated; an id the workspace does not hold is icp_not_found", async () => {
  const [{ workspace }] = await createTwoWorkspaces();
  const ws = workspace.id;
  const audience = await run(ws, () => createAudience({ name: "Bakeries", createdBy: "usr_a" }));
  /** The worker's part: the audience's run drafted, as the drafter leaves it. */
  const drafted = async () => {
    const pendingDraft = { model: "fake-model", promptVersion: 1, decisionRecordId: "dec_c" };
    const data = { draftStatus: "drafted", pendingDraft: { ...pendingDraft, fields: PROPOSAL } };
    await run(ws, (tx) => tx.icp.updateMany({ where: { id: audience.id }, data }));
  };
  const lines: string[] = [];
  const options = { client: asRole("app"), pollMs: 1, timeoutMs: 10_000, wait: drafted };
  const draft = (icpId: string) => {
    lines.length = 0;
    const args = ["--workspace", ws, "--icp", icpId, "--brief", "Bakeries in France"];
    return runDraft(args, (line) => lines.push(line), options);
  };

  assert.equal(await draft(audience.id), 0);
  const requested = new RegExp(
    `^icp_draft_requested: (idrun_\\w+) in ${ws}, audience ${audience.id}$`,
  );
  const draftRunId = requested.exec(lines[0] ?? "")?.[1];
  assert.ok(draftRunId, lines[0] ?? "no line");
  assert.equal(
    lines.at(-1),
    `icp_saved: version 2 of ${audience.id}; not the default audience: no re-score`,
  );
  const rows = await run(ws, (tx) => tx.icp.findMany({ orderBy: { isDefault: "desc" } }));
  assert.deepEqual(
    rows.map((row) => [row.isDefault, row.version, row.titles, row.draftStatus]),
    [
      [true, 1, [], "none"],
      [false, 2, PROPOSAL.titles, "none"],
    ],
  );
  const payloads = async (eventName: string) =>
    (await outbox(ws, eventName)).map((entry) => entry.payload);
  assert.deepEqual(await payloads("icp.draft_requested"), [
    { workspaceId: ws, icpId: audience.id, draftRunId },
  ]);
  assert.deepEqual(await payloads("icp.audience_updated"), [
    { workspaceId: ws, icpId: audience.id, version: 2 },
  ]);
  assert.deepEqual(await payloads("icp.updated"), []);

  assert.equal(await draft("icp_none"), 1);
  assert.deepEqual(lines, ["icp_not_found: icp_none"]);
});
