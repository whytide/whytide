// The price list (alpha-p3-060): the PRICE_<ACTION> override parser, then, in this file's schema of
// the worktree's database, the list the api's start writes, as billing_writer: an override changes
// priceOf after a restart and writes the next version; the same list again writes nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, isAppError, servicePrincipal } from "@whytide/platform";
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
