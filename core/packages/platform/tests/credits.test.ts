// The credits client and the price registry (credits/): a call before the credits module binds its
// implementation fails with credits_not_bound, then each method reaches the bound one; an action
// priced twice fails at start naming both files.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindCreditsClient,
  type CreditsClient,
  credits,
  definePrices,
  registeredPrices,
} from "../credits/index.ts";
import { isAppError } from "../errors/index.ts";
import { throwsCode } from "../testing/index.ts";

test("a call before binding fails with credits_not_bound; once bound, the client delegates", async () => {
  const input = {
    workspaceId: "wsp_1",
    action: "fixture.read",
    quantity: 1,
    idempotencyKey: "k",
    subjectRef: "lead_1",
    lease: "sync",
  } as const;
  await assert.rejects(credits.reserve(input), { code: "credits_not_bound" });
  const usage = { usageId: "usage_1", credits: "1" };
  const bound: CreditsClient = {
    reserve: async () => usage,
    commit: async (usageId) => ({ usageId, credits: "0.5" }),
    release: async () => undefined,
    balance: async () => ({
      available: "1",
      granted: "1",
      reserved: "0",
      committed: "0",
      periodEnd: null,
    }),
    priceOf: async (action) => ({ action, credits: "1", unit: "lead", version: 1 }),
  };
  bindCreditsClient(bound);
  assert.deepEqual(await credits.reserve(input), usage);
  assert.deepEqual(await credits.commit("usage_1", 1), { usageId: "usage_1", credits: "0.5" });
  assert.equal((await credits.priceOf("fixture.read")).version, 1);
});

test("an action is priced once: a second module pricing it fails naming both files", () => {
  const first = "core/modules/fixture/prices.ts";
  const second = "core/modules/other/prices.ts";
  const prices = definePrices([{ action: "fixture.assess", credits: 0.5, unit: "lead" }], first);
  assert.deepEqual(prices, { "fixture.assess": "fixture.assess" });
  assert.throws(
    () => definePrices([{ action: "fixture.assess", credits: 1, unit: "lead" }], second),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "duplicate_price_action");
      assert.deepEqual(error.details, { action: "fixture.assess", sources: [first, second] });
      return true;
    },
  );
  assert.equal(registeredPrices().get("fixture.assess")?.credits, 0.5);
  for (const bad of [{ credits: -1 }, { credits: Number.NaN }, { action: "Assess" }]) {
    const definition = { action: "fixture.other", credits: 1, unit: "lead", ...bad };
    throwsCode(() => definePrices([definition], first), "invalid_price_definition");
  }
});
