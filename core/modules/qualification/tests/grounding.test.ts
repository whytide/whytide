// The why bullets of the grounding sample (README.md "Public interface"), on the LLM fake and the
// worktree's database: the lead's fit bullet, which quotes the model, worded in English with what
// the model read, from the decision record's raw prompt, then rebuilt after the raw purge; the gap
// bullet, which quotes nothing, another week and a snapshot gone give none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { purgeRawRecords } from "@whytide/ai";
import { createLeadForPerson, getCompany, getPerson } from "@whytide/contacts";
import { asRole, withTestDb } from "@whytide/db/testing";
import { readIcpForScoring } from "@whytide/icp";
import { servicePrincipal } from "@whytide/platform";
import { assessmentInput, assessPerson } from "../domain/assess/assess-person.ts";
import { whySample } from "../domain/export/grounding.ts";
import { scoreSnapshot } from "../domain/score/score-snapshot.ts";
import type { AssessFitInput } from "../schemas/assess-fit.ts";
import { useQualificationClient } from "../testing/index.ts";
import { answer, contextOf, fake, run, seed } from "./fixtures/assess.ts";

withTestDb();
useQualificationClient(asRole("app"));
const WS = "wsp_qualification_grounding";
const tenant = { workspaceId: WS, principal: servicePrincipal("qualification_test") };
const DAY = 86_400_000;
const around = (at: number) => ({ week: "", from: new Date(at - DAY), to: new Date(at + DAY) });
const FIELDS = ["headline", "title", "country"].map((field) => `profile.${field}`);
const COMPANY = ["name", "industry", "size"].map((field) => `company.${field}`);
const valuesOf = (input: AssessFitInput) =>
  [...Object.values(input.profile), ...Object.values(input.company), ...input.evidence].filter(
    (value) => value !== null,
  );

test("the lead's fit bullet with what the model read, from the raw prompt, then rebuilt after the raw purge; none for its gap bullet, another week or a snapshot gone", async () => {
  const personId = await seed(WS);
  await run(WS, () =>
    createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } }),
  );
  fake.script(answer());
  const excerpt = "Adaeze is hiring two SDRs: https://quill.example/jobs";
  const context = contextOf(WS);
  const result = await assessPerson({ personId, icpVersion: 1, evidence: [excerpt] }, context);
  if (result.status !== "assessed") throw new Error(`assessPerson: ${result.status}`);
  const { snapshotId } = result;
  const { decisionRecordId } = await run(WS, async (tx) => {
    await scoreSnapshot(snapshotId);
    return tx.scoreSnapshot.findFirstOrThrow({ where: { id: snapshotId } });
  });
  const inputs = await run(WS, async () => {
    const person = await getPerson(personId);
    const company = person.companyId === null ? null : await getCompany(person.companyId);
    const { icp } = await readIcpForScoring(WS);
    const sent = assessmentInput(person, company, icp, [excerpt]);
    return { sent, now: assessmentInput(person, company, icp), companyId: person.companyId };
  });

  const refs = await whySample.list(tenant, around(Date.now()));
  assert.deepEqual(refs, [`${snapshotId}:0`]);
  const [item] = await whySample.read(tenant, refs);
  assert.equal(item?.text, "Title and function: “Head of Revenue Operations”, 5 of 6 criteria met");
  const record = `decision_records/${decisionRecordId}#`;
  assert.deepEqual(item?.facts, [
    ...[...FIELDS, ...COMPANY, "evidence.0"].map((field, index) => ({
      value: valuesOf(inputs.sent)[index],
      source: `${record}${field}`,
    })),
  ]);
  assert.ok(item?.facts.some((fact) => fact.value.includes("Head of Revenue Operations")));
  assert.doesNotMatch(JSON.stringify(item), /Adaeze|Quill|Feather|quill\.example/);

  assert.ok(
    (await purgeRawRecords({ client: asRole("app"), now: new Date(Date.now() + 400 * DAY) })) >= 1,
  );
  const [rebuilt] = await whySample.read(tenant, refs);
  const owner = (field: string) =>
    field.startsWith("company.")
      ? `workspace_companies/${inputs.companyId}`
      : `persons/${personId}`;
  assert.deepEqual(
    rebuilt?.facts,
    [...FIELDS, ...COMPANY].map((field, index) => ({
      value: valuesOf(inputs.now)[index],
      source: `${owner(field)}#${field}`,
    })),
  );

  assert.deepEqual(await whySample.list(tenant, around(Date.now() - 30 * DAY)), []);
  assert.deepEqual(await whySample.read(tenant, [`${snapshotId}:1`, "ssn_gone:0"]), []);
});
