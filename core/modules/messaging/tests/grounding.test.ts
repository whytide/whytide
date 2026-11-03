// The drafts of the grounding sample (README.md "Public interface"), on the worktree's database:
// a draft of the week with the writer's text, with its lead's dossier facts and their sources; a
// draft still drafting, a sequence's empty connection note, one of the next week and one gone give
// none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { buildDossier } from "../domain/dossier/build.ts";
import { draftSample } from "../domain/drafts/grounding.ts";
import { createMessageDraft, createStepDraft, useMessagingClient } from "../testing/index.ts";
import { COMMENT, GROUNDED, seed } from "./fixtures/draft.ts";

withTestDb();
useMessagingClient(asRole("app"));
const WEEK = {
  week: "2026-W43",
  from: new Date("2026-10-19T00:00:00.000Z"),
  to: new Date("2026-10-26T00:00:00.000Z"),
};
const day = (date: number) => new Date(`2026-10-${date}T10:00:00.000Z`);

test("a draft of the week with the writer's text, with its lead's dossier facts as sources; none still drafting, an empty connection note, of the next week or gone", async () => {
  const { workspaceId, personId, userId } = await seed();
  const tenant = { workspaceId, principal: servicePrincipal("messaging_test") };
  const draft = { workspaceId, personId, text: GROUNDED };
  const written = await createMessageDraft({ ...draft, createdAt: day(21) });
  await createMessageDraft({ workspaceId, personId, status: "drafting", createdAt: day(22) });
  const note = { stepExecutionId: "sx_connect", stepKey: "connect" as const, text: "" };
  await createStepDraft({ workspaceId, personId, ...note, createdAt: day(23) });
  await createMessageDraft({ ...draft, createdAt: day(26) });
  assert.deepEqual(await draftSample.list(tenant, WEEK), [written]);

  const [item, ...others] = await draftSample.read(tenant, [written, "mdr_gone"]);
  assert.deepEqual([item?.ref, item?.text, others], [written, GROUNDED, []]);
  const { facts } = await buildDossier(tenant, personId);
  assert.deepEqual(
    item?.facts,
    facts.map(({ value, sourceRef }) => ({ value, source: sourceRef })),
  );
  const sources = (value: string) =>
    item?.facts.filter((fact) => fact.value === value).map((fact) => fact.source);
  assert.deepEqual(sources("Ines"), [`persons/${personId}/first_name`]);
  assert.match(
    sources(COMMENT)?.join() ?? "",
    /^evidence\/(\w+)\/excerpt,evidence\/\1\/comment_text$/,
  );
  assert.ok(!item?.facts.some((fact) => fact.source.startsWith(`users/${userId}`)), "no sender");
});
