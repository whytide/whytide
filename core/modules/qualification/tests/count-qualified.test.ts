// countQualified (README "Public interface"), credits' count of the leads a week qualified: the
// persons an assessment's own snapshot scored `qualified` in [from, to), each once. A re-score's copy,
// another status, a snapshot outside the span or of another workspace is not counted.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { countQualified } from "../domain/score/count-qualified.ts";
import { createScoreSnapshot } from "../testing/index.ts";

withTestDb();
const WS = "wsp_qualification_count";
const principal = servicePrincipal("qualification_test");
const from = new Date("2026-10-19T00:00:00.000Z");
const to = new Date("2026-10-26T00:00:00.000Z");
const inside = new Date("2026-10-21T10:00:00.000Z");

test("countQualified: the persons an assessment's own snapshot qualified in [from, to), each once", async () => {
  const snapshot = (
    personId: string,
    createdAt: Date,
    more: { status?: "not_qualified"; criteriaHash?: string; workspaceId?: string } = {},
  ) => createScoreSnapshot({ workspaceId: WS, personId, status: "qualified", createdAt, ...more });
  await snapshot("per_first", from);
  await snapshot("per_first", inside);
  await snapshot("per_last", new Date(to.getTime() - 1));
  await snapshot("per_after", to);
  await snapshot("per_before", new Date(from.getTime() - 1));
  await snapshot("per_copy", inside, { criteriaHash: "a".repeat(64) });
  await snapshot("per_not", inside, { status: "not_qualified" });
  await snapshot("per_other", inside, { workspaceId: "wsp_qualification_count_b" });
  const count = await withTenant(
    { workspaceId: WS, principal },
    () => countQualified({ from, to }),
    { client: asRole("app") },
  );
  assert.equal(count, 2);
});
