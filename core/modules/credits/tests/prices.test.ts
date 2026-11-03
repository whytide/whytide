// The price list (alpha-p3-060): the PRICE_<ACTION> override parser, then, in this file's schema of
// the worktree's database, the list the api's start writes, as billing_writer: an override changes
// priceOf after a restart and writes the next version; the same list again writes nothing. signals'
// price per engager (beta-p1-090), its credits SIGNALS_CREDITS_PER_ENGAGER's, under the override.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  collectLogs,
  createLogger,
  isAppError,
  registeredPrices,
  servicePrincipal,
} from "@whytide/platform";
import { prices as signalsPrices } from "@whytide/signals";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { createCreditsClient } from "../domain/client.ts";
import { assemblePrices, priceVariable, syncPrices } from "../domain/prices.ts";

withTestDb();
useTenancyClient(asRole("app"));
const log = createLogger({ destination: collectLogs().destination });
const declared = [{ action: "qualification.assessment", credits: 1, unit: "lead" }];

test("the override parser: PRICE_ and the action in upper case; a malformed value stops the start, naming the variable only", () => {
  assert.equal(priceVariable("signals.engager_read"), "PRICE_SIGNALS_ENGAGER_READ");
  const env = { PRICE_QUALIFICATION_ASSESSMENT: " 0.25 " };
  assert.deepEqual(assemblePrices(declared, env), [{ ...declared[0], credits: "0.25" }]);
  assert.deepEqual(assemblePrices(declared, { PRICE_QUALIFICATION_ASSESSMENT: "" }), [
    { ...declared[0], credits: "1" },
  ]);
  for (const value of ["-1", "1e3", "half", "0,5"]) {
    const env = { PRICE_QUALIFICATION_ASSESSMENT: value };
    assert.throws(
      () => assemblePrices(declared, env),
      (error: unknown) => {
        assert.ok(isAppError(error) && error.code === "config_invalid");
        const variables = ["PRICE_QUALIFICATION_ASSESSMENT"];
        assert.deepEqual(error.details, { block: "modules/credits", variables });
        return true;
      },
    );
  }
});

test("PRICE_QUALIFICATION_ASSESSMENT=0.5 changes priceOf after a restart and bumps price_list.version", async () => {
  const [a] = await createTwoWorkspaces();
  const billing = asRole("billing_writer");
  const credits = createCreditsClient();
  const principal = servicePrincipal("credits_test");
  const priceOf = () =>
    withTenant(
      { workspaceId: a.workspace.id, principal },
      () => credits.priceOf("qualification.assessment"),
      { client: asRole("app") },
    );
  assert.equal(await syncPrices(billing, assemblePrices(declared, {}), log), 1);
  const price = { action: "qualification.assessment", credits: "1", unit: "lead", version: 1 };
  assert.deepEqual(await priceOf(), price);
  const env = { PRICE_QUALIFICATION_ASSESSMENT: "0.5" };
  assert.equal(await syncPrices(billing, assemblePrices(declared, env), log), 2);
  assert.deepEqual(await priceOf(), { ...price, credits: "0.5", version: 2 });
  assert.equal(await syncPrices(billing, assemblePrices(declared, env), log), 2);
  assert.equal(await billing.priceListEntry.count(), 2);
});

test("PRICE_SIGNALS_ENGAGER overrides signals.engager, which signals declares at SIGNALS_CREDITS_PER_ENGAGER's credits, 1 by default; signals.engager_read keeps its own", async () => {
  const [a] = await createTwoWorkspaces();
  const engager = registeredPrices().get(signalsPrices["signals.engager"]);
  const read = registeredPrices().get(signalsPrices["signals.engager_read"]);
  assert.ok(engager !== undefined && read !== undefined);
  assert.equal(priceVariable(engager.action), "PRICE_SIGNALS_ENGAGER");
  const env = { PRICE_SIGNALS_ENGAGER: "3" };
  const priced = (credits: string) => [
    { action: "signals.engager", credits, unit: "engager" },
    { action: "signals.engager_read", credits: "1", unit: "engagers_30" },
  ];
  assert.deepEqual(assemblePrices([engager, read], {}), priced("1"));
  assert.deepEqual(assemblePrices([engager, read], env), priced("3"));
  const billing = asRole("billing_writer");
  assert.equal(await syncPrices(billing, assemblePrices([engager, read], {}), log), 1);
  assert.equal(await syncPrices(billing, assemblePrices([engager, read], env), log), 2);
  const principal = servicePrincipal("credits_test");
  const priceOf = (action: string) =>
    withTenant(
      { workspaceId: a.workspace.id, principal },
      () => createCreditsClient().priceOf(action),
      {
        client: asRole("app"),
      },
    );
  const unit = { unit: "engager", version: 2 };
  assert.deepEqual(await priceOf("signals.engager"), {
    action: "signals.engager",
    credits: "3",
    ...unit,
  });
  const block = await priceOf("signals.engager_read");
  assert.deepEqual([block.credits, block.version], ["1", 2]);
});
