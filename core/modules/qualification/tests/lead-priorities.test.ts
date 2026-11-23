// leadPriorities (README "Public interface"), on the worktree's database: the scored persons'
// priority and tier in one query, the highest first; a person with no row, or another workspace's,
// left out; [] for no ids; testing's setLeadPriority writes the row and its tier.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PrismaClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { leadPriorities, setLeadPriority } from "../domain/intent/store.ts";
import { run } from "./fixtures/assess.ts";

withTestDb();
const WS = "wsp_qualification_priorities";
const OTHER = "wsp_qualification_priorities_other";

test("leadPriorities: each scored person's priority and tier in one query, the highest first; a person with no row or another workspace's left out; [] for no ids", async () => {
  await run(WS, async () => {
    await setLeadPriority("per_warm", 60);
    await setLeadPriority("per_hot", 75);
    await setLeadPriority("per_cool", 54);
  });
  await run(OTHER, () => setLeadPriority("per_other", 90));
  const row = await run(WS, (tx) =>
    tx.intentScore.findFirstOrThrow({ where: { personId: "per_hot" } }),
  );
  assert.deepEqual(
    [
      row.intentScore,
      row.priority,
      row.tier,
      row.intentBreakdown,
      row.whyNowEventId,
      row.boostUntil,
    ],
    [0, 75, "hot", [], null, null],
  );

  let queries = 0;
  const counting = asRole("app").$extends({
    query: {
      async $allOperations({ model, args, query }) {
        if (model === "IntentScore") queries += 1;
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
  const principal = servicePrincipal("qualification_test");
  const ids = ["per_cool", "per_none", "per_hot", "per_other", "per_warm", "per_hot"];
  const answered = await withTenant({ workspaceId: WS, principal }, () => leadPriorities(ids), {
    client: counting,
  });
  assert.deepEqual(answered, [
    { personId: "per_hot", priority: 75, tier: "hot" },
    { personId: "per_warm", priority: 60, tier: "warm" },
    { personId: "per_cool", priority: 54, tier: "cool" },
  ]);
  assert.equal(queries, 1);
  assert.deepEqual(await run(WS, () => leadPriorities([])), []);
  assert.deepEqual(await run(OTHER, () => leadPriorities(["per_hot", "per_other"])), [
    { personId: "per_other", priority: 90, tier: "hot" },
  ]);
  await assert.rejects(
    run(WS, () => leadPriorities([""])),
    {
      code: "qualification_input_invalid",
      details: { fields: ["personIds"] },
    },
  );
});

test("setLeadPriority writes the person's row again: a new priority and its tier", async () => {
  await run(WS, () => setLeadPriority("per_1", 80));
  await run(WS, () => setLeadPriority("per_1", 55));
  assert.deepEqual(await run(WS, () => leadPriorities(["per_1"])), [
    { personId: "per_1", priority: 55, tier: "warm" },
  ]);
});
