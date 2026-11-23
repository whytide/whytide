// The batch's units (README "The batch"): the reservation's idempotency key, and the subscribers,
// which start the batch of the workspace they are delivered in, one at a time by its fixed id;
// then, on the database, the lead's audience and the batch's selection (domain/audience.ts,
// gamma-p5-050) with its first step, which filters each lead by its own audience, and the tick's
// check, hasWork; 600 leads waiting for an unsaved audience hold back no other's (review-gaps-2); a
// lead held for enrichment waits, and a company sized by its headcount alone is filtered by it
// (gamma-en-040): agents seeded through playbooks' test helper, leads through contacts' commands,
// each new lead selectable at once unless a test holds it. The batch itself runs end to end in
// core/apps/worker/tests/qualification-batch.test.ts: a module never imports a host.
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyQualification,
  createLeadForPerson,
  createLeadsForPersons,
  getLead,
  linkPersonToCompany,
  releaseEnrichmentHold,
  upsertCompany,
  upsertPersonsFromSource,
} from "@whytide/contacts";
import { useEnrichmentHold } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { events as discovery } from "@whytide/discovery";
import { events as icp, readIcpForScoring } from "@whytide/icp";
import {
  bindWorkflowStarter,
  servicePrincipal,
  subscribersOf,
  type WorkflowStart,
  withTenantContext,
} from "@whytide/platform";
import { createPlaybook, type SeededPlaybook } from "@whytide/playbooks/testing";
import { readAudiences, selectLeads } from "../domain/audience.ts";
import { useClient } from "../domain/client.ts";
import { batchStart } from "../events.ts";
import { assessmentKey, filterLeads, hasWork } from "../workflows/batch.ts";
import { workflows } from "../workflows/index.ts";
import { addAudience, PERSON, run, seed, seedPerson } from "./fixtures/assess.ts";

withTestDb();
useEnrichmentHold(0);

test("the idempotency key is qual:{personId}:{icpId}:{icpVersion}:{model}:{promptVersion}, then :{attempt} from the second; a batch of before audiences keeps the key of before", () => {
  const key = {
    personId: "per_1",
    icpId: "icp_a",
    icpVersion: 3,
    modelId: "fake-model",
    promptVersion: 1,
  };
  assert.equal(assessmentKey(key), "qual:per_1:icp_a:3:fake-model:1");
  assert.equal(assessmentKey({ ...key, attempt: 1 }), "qual:per_1:icp_a:3:fake-model:1");
  assert.equal(assessmentKey({ ...key, attempt: 2 }), "qual:per_1:icp_a:3:fake-model:1:2");
  assert.notEqual(assessmentKey({ ...key, icpVersion: 4 }), assessmentKey(key));
  assert.notEqual(assessmentKey({ ...key, icpId: "icp_b" }), assessmentKey(key));
  const { icpId: _, ...before } = key;
  assert.equal(assessmentKey(before), "qual:per_1:3:fake-model:1");
  assert.equal(assessmentKey({ ...before, attempt: 2 }), "qual:per_1:3:fake-model:1:2");
});

test("discovery.people_imported, icp.updated and icp.audience_updated start qualification_batch of the delivered workspace, one at a time by qualification.batch:<workspace>:current", async () => {
  const start = batchStart("wsp_a");
  assert.deepEqual(start, {
    workflow: "qualification_batch",
    input: { workspaceId: "wsp_a" },
    workflowId: "qualification.batch:wsp_a:current",
    oneAtATime: true,
  });
  assert.deepEqual(workflows.qualification_batch.input.parse(start.input), start.input);

  const starts: WorkflowStart[] = [];
  const unbind = bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
  const workspaceId = "wsp_delivered";
  const payloads = [
    [
      discovery["discovery.people_imported"],
      { workspaceId: "wsp_other", jobId: "job_1", personIds: ["per_1"] },
    ],
    [icp["icp.updated"], { workspaceId: "wsp_other", version: 2 }],
    [icp["icp.audience_updated"], { workspaceId: "wsp_other", icpId: "icp_a", version: 2 }],
  ] as const;
  try {
    await withTenantContext({ workspaceId, principal: servicePrincipal("test") }, async () => {
      for (const [name, payload] of payloads) {
        const context = {
          id: "obx_a",
          name,
          workspaceId,
          createdAt: new Date(),
          attempt: 1,
          tx: {},
        };
        for (const handler of subscribersOf(name)) await handler(payload, context);
      }
    });
  } finally {
    unbind();
  }
  assert.deepEqual(starts, [
    batchStart(workspaceId),
    batchStart(workspaceId),
    batchStart(workspaceId),
  ]);
});

const WS = "wsp_qualification_batch";
/** An ICP with no targeting at all: an audience made and never saved. */
const UNSAVED = {
  titles: [],
  seniorities: [],
  industries: [],
  sizeRanges: [],
  countries: [],
  mustHaves: "",
  disqualifiers: "",
};
/** The batch's activity context in WS, as the worker gives it. */
const context = {
  workspaceId: WS,
  workflowId: "qualification.batch:wsp_qualification_batch:current",
  attempt: 1,
  tenant: <T>(fn: Parameters<typeof run<T>>[1]) => run(WS, fn),
};

/** The person's lead, found by the signal source `ref`, or imported. */
function lead(personId: string, ref?: string) {
  const source =
    ref === undefined
      ? ({ kind: "imported", ref: "job_1" } as const)
      : { kind: "signal" as const, ref };
  return run(WS, () => createLeadForPerson({ personId, source }));
}

/** An agent of the audience holding the signal source. */
function agent(icpId: string, sourceId: string, status: SeededPlaybook["status"] = "active") {
  return createPlaybook({
    workspaceId: WS,
    icpId,
    ownerUserId: "usr_owner",
    status,
    sourceIds: [sourceId],
  });
}

/** The default audience's id. */
const defaultId = () => run(WS, async () => (await readIcpForScoring(WS)).icp.id);

/** The batch's selection of up to `limit` leads: [person, audience] pairs, oldest first. */
function selected(limit = 10) {
  return run(WS, async () => {
    const leads = await selectLeads(await readAudiences(WS), limit);
    return leads.map(({ lead, icpId }): [string, string] => [lead.personId, icpId]);
  });
}

test("a lead is judged against its first signal source's agent's audience, whatever the agent's status; an imported lead, and one whose source is in no agent, against the default", async () => {
  const found = await seed(WS);
  const founders = await addAudience(WS, "Founders", { countries: ["DE"] });
  await agent(founders, "src_founders");
  await agent(founders, "src_archived", "archived");
  const archived = await seedPerson(WS, "found-by-an-archived-agent");
  const imported = await seedPerson(WS, "imported");
  const stray = await seedPerson(WS, "source-in-no-agent");
  await lead(found, "src_founders");
  await lead(archived, "src_archived");
  await lead(imported);
  await lead(stray, "src_stray");

  const fallback = await defaultId();
  const expected = [founders, founders, fallback, fallback];
  const people = [found, archived, imported, stray];
  assert.deepEqual(new Map(await selected()), new Map(people.map((p, i) => [p, expected[i]])));
});

test("a lead whose audience has no targeting is left as it is, and holds back no other audience's lead", async () => {
  const waiting = await seedPerson(WS, "found-by-an-unsaved-agent");
  const imported = await seed(WS);
  const unsaved = await addAudience(WS, "Unsaved", UNSAVED);
  await agent(unsaved, "src_unsaved");
  await lead(waiting, "src_unsaved");
  await lead(imported);

  assert.equal((await run(WS, () => readAudiences(WS))).targeted.has(unsaved), false);
  assert.deepEqual(await selected(1), [[imported, await defaultId()]]);
  await filterLeads({ audiences: true }, context);
  const left = await run(WS, () => getLead(waiting));
  assert.equal(left.qualificationStatus, "pending");
  assert.equal(left.icpIdScored, null);
});

test("the batch's first step filters each lead by its own audience: a miss is hard_filtered against that audience, the rest come grouped by audience; a batch started before audiences gets no lead", async () => {
  const passes = await seed(WS);
  const france = await addAudience(WS, "France", { countries: ["FR"] });
  await agent(france, "src_france");
  const misses = await seedPerson(WS, "in-berlin-found-for-france");
  await lead(passes);
  await lead(misses, "src_france");

  const read = await filterLeads({ audiences: true }, context);
  const groups = [{ icpId: await defaultId(), icpVersion: 1, personIds: [passes] }];
  assert.deepEqual(read, { groups, filtered: 1 });
  const missed = await run(WS, () => getLead(misses));
  assert.equal(missed.qualificationStatus, "hard_filtered");
  assert.equal(missed.hardFilterReason, "country_mismatch");
  assert.equal(missed.icpIdScored, france);
  assert.equal(missed.icpVersionScored, 1);

  assert.deepEqual(await filterLeads({}, context), { icpVersion: 1, personIds: [], filtered: 0 });
});

test("after an audience's version moves, only the leads decided against it are selected again", async () => {
  const imported = await seed(WS);
  const founders = await addAudience(WS, "Founders");
  await agent(founders, "src_founders");
  const found = await seedPerson(WS, "found-for-founders");
  await lead(imported);
  await lead(found, "src_founders");
  const fallback = await defaultId();
  await run(WS, async () => {
    const decided = { status: "qualified", fitScore: 80, icpVersion: 1 } as const;
    await applyQualification({ personId: imported, ...decided, icpId: fallback });
    await applyQualification({ personId: found, ...decided, icpId: founders });
  });
  assert.deepEqual(await selected(), []);

  await run(WS, (tx) => tx.icp.update({ where: { id: founders }, data: { version: 2 } }));
  assert.deepEqual(await selected(), [[found, founders]]);
});

/** `count` leads found by the signal source `ref`, older than any lead made after: their ids. */
function oldLeads(count: number, ref: string) {
  return run(WS, async (tx) => {
    const profiles = Array.from({ length: count }, (_, n) => ({
      source: "import" as const,
      provider: "csv" as const,
      profile: { ...PERSON, linkedinUrl: `https://linkedin.com/in/waiting-${n}` },
    }));
    const personIds = (await upsertPersonsFromSource(profiles)).map((answer) => {
      if (!("person" in answer)) throw new Error(`a waiting person was refused: ${answer.code}`);
      return answer.person.id;
    });
    const source = { kind: "signal" as const, ref };
    await createLeadsForPersons(personIds.map((personId) => ({ personId, source })));
    const where = { personId: { in: personIds } };
    await tx.lead.updateMany({ where, data: { createdAt: new Date("2020-01-01T00:00:00Z") } });
    return personIds;
  });
}

test("600 leads waiting for an agent's unsaved audience, older than the others, hold back neither a saved audience's lead nor the default's and stay pending; hasWork answers true for the two and false when only the 600 wait; once that audience is saved, its leads are selected", async () => {
  const imported = await seed(WS);
  const founders = await addAudience(WS, "Founders");
  await agent(founders, "src_founders");
  const unsaved = await addAudience(WS, "Unsaved", UNSAVED);
  await agent(unsaved, "src_unsaved");
  const waiting = await oldLeads(600, "src_unsaved");
  const found = await seedPerson(WS, "found-for-founders");
  await lead(imported);
  await lead(found, "src_founders");
  const fallback = await defaultId();
  useClient(asRole("app"));
  try {
    assert.deepEqual(await selected(), [
      [imported, fallback],
      [found, founders],
    ]);
    assert.equal(await hasWork(WS), true, "the two wait");
    const read = await filterLeads({ audiences: true }, context);
    assert.deepEqual(read.filtered, 0);
    const untouched = { personId: { in: waiting }, qualificationStatus: "pending" as const };
    const stay = () =>
      run(WS, (tx) => tx.lead.count({ where: { ...untouched, icpIdScored: null } }));
    assert.equal(await stay(), 600, "the 600 stay pending");

    await run(WS, async () => {
      const decided = { status: "qualified", fitScore: 80, icpVersion: 1 } as const;
      await applyQualification({ personId: imported, ...decided, icpId: fallback });
      await applyQualification({ personId: found, ...decided, icpId: founders });
    });
    assert.deepEqual(await selected(), []);
    assert.equal(await hasWork(WS), false, "only the 600 wait, for an audience with no targeting");
    assert.equal(await stay(), 600);

    await run(WS, (tx) => tx.icp.update({ where: { id: unsaved }, data: { countries: ["DE"] } }));
    const now = await selected(10);
    assert.equal(now.length, 10);
    const first = [...waiting].sort().slice(0, 10);
    assert.deepEqual(
      now,
      first.map((personId) => [personId, unsaved]),
      "the oldest, by person id",
    );
    assert.equal(await hasWork(WS), true);
  } finally {
    useClient(undefined);
  }
});

test("a lead held for enrichment is not selected and hasWork answers false while the workspace's only pending leads are held; released, it is selected at once (gamma-en-040)", async () => {
  const held = await seed(WS);
  useEnrichmentHold(60);
  await lead(held);
  useEnrichmentHold(0);
  // hasWork opens its own run, on the module's client: this file's schema.
  useClient(asRole("app"));
  try {
    assert.deepEqual(await selected(), []);
    assert.equal(await hasWork(WS), false);
    const read = await filterLeads({ audiences: true }, context);
    assert.deepEqual(read, { groups: [], filtered: 0 });
    assert.equal((await run(WS, () => getLead(held))).qualificationStatus, "pending");

    assert.equal(await run(WS, () => releaseEnrichmentHold([held])), 1);
    assert.equal(await hasWork(WS), true);
    assert.deepEqual(await selected(), [[held, await defaultId()]]);
  } finally {
    useClient(undefined);
  }
});

test('a company upserted with its headcount alone, 1234, is sized "1234", which the size filter reads as 1001-5000: an audience of 1001-5000 passes its lead, one of 1-10 hard-filters it (gamma-en-040)', async () => {
  const passes = await seed(WS, { sizeRanges: ["1001-5000"] });
  const small = await addAudience(WS, "Small", { sizeRanges: ["1-10"] });
  await agent(small, "src_small");
  const misses = await seedPerson(WS, "counted-for-small");
  await run(WS, async () => {
    const company = { name: "Counted Labs", domain: "counted.example", employeeCount: 1234 };
    const { company: counted } = await upsertCompany({
      source: "open_data",
      provider: "wikidata",
      company,
    });
    assert.equal(counted.sizeRange, "1234");
    for (const personId of [passes, misses]) {
      await linkPersonToCompany({ personId, companyId: counted.id });
    }
  });
  await lead(passes);
  await lead(misses, "src_small");

  const read = await filterLeads({ audiences: true }, context);
  const groups = [{ icpId: await defaultId(), icpVersion: 1, personIds: [passes] }];
  assert.deepEqual(read, { groups, filtered: 1 });
  const missed = await run(WS, () => getLead(misses));
  assert.deepEqual(
    [missed.qualificationStatus, missed.hardFilterReason, missed.icpIdScored],
    ["hard_filtered", "size_mismatch", small],
  );
});
