// The price list (alpha-p3-060, gamma-p2-060): the PRICE_<ACTION> override parser, then, in this
// file's schema of the worktree's database, the list the api's start writes as billing_writer, each
// start at an instant the test gives, and the price priceOf reads at another: unchanged prices, an
// addition, a drop to 0 included, a rise announced 30 days ahead, a rise beside a drop, an addition
// and a removal, another unit, a restart during a notice, a change during it, a withdrawal, and
// listPrices' `next`; the CHECK on withdrawn_at and billing_writer's UPDATE narrowed to it. signals'
// price per engager (beta-p1-090), its credits SIGNALS_CREDITS_PER_ENGAGER's, under the override.
import assert from "node:assert/strict";
import test from "node:test";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
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
import { DAY_MS } from "../domain/constants.ts";
import {
  assemblePrices,
  listPrices,
  type PriceEntry,
  priceVariable,
  syncPrices,
} from "../domain/prices.ts";
import { settings } from "../settings.ts";
import { grantAllowance } from "../testing/index.ts";

withTestDb();
useTenancyClient(asRole("app"));
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const principal = servicePrincipal("credits_test");
const declared = [{ action: "qualification.assessment", credits: 1, unit: "lead" }];

/** The first start, and an instant `days` after it: no test reads the clock. */
const T0 = new Date("2026-11-02T09:00:00Z");
const day = (days: number) => new Date(T0.getTime() + days * DAY_MS);
/** The date a rise announced at `day(days)` applies from. */
const dateOf = (days: number) => day(days + settings.CREDITS_PRICE_CHANGE_NOTICE_DAYS);

/** `test.a 1 lead`-like entries. */
const list = (...entries: string[]): PriceEntry[] =>
  entries.map((entry) => {
    const [action = "", credits = "", unit = "lead"] = entry.split(" ");
    return { action, credits, unit };
  });
const sync = (entries: PriceEntry[], at: Date) =>
  syncPrices(asRole("billing_writer"), entries, log, at);

/** Each version as written: its entries, from when, announced when and withdrawn when. */
async function versions() {
  const rows = await asRole("billing_writer").priceListEntry.findMany({
    orderBy: [{ version: "asc" }, { action: "asc" }],
  });
  const byVersion = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    const entry = `${row.action} ${row.credits.toFixed()} ${row.unit}`;
    const seen = byVersion.get(row.version);
    if (seen) {
      (seen.entries as string[]).push(entry);
      continue;
    }
    byVersion.set(row.version, {
      version: row.version,
      entries: [entry],
      from: row.effectiveFrom.toISOString(),
      announced: row.announcedAt?.toISOString() ?? null,
      withdrawn: row.withdrawnAt?.toISOString() ?? null,
    });
  }
  return [...byVersion.values()];
}
const version = (
  number: number,
  entries: string[],
  from: Date,
  announced: Date | null = null,
  withdrawn: Date | null = null,
) => ({
  version: number,
  entries,
  from: from.toISOString(),
  announced: announced?.toISOString() ?? null,
  withdrawn: withdrawn?.toISOString() ?? null,
});

/** priceOf in a run of the workspace, on a client whose clock reads `at`. */
async function priceAt(workspaceId: string, action: string, at: Date) {
  const { credits, unit, version } = await withTenant(
    { workspaceId, principal },
    () => createCreditsClient(() => at).priceOf(action),
    { client: asRole("app") },
  );
  return `${credits} ${unit} v${version}`;
}
/** The lines logged from now on with the message: each test reads its own. */
function logged() {
  const start = logs.lines().length;
  return (message: string) =>
    logs
      .lines()
      .slice(start)
      .filter((line) => line.msg === message);
}

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

test("PRICE_QUALIFICATION_ASSESSMENT=0.5, a drop, changes priceOf at the next start and writes the next version; the same list again writes nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const action = "qualification.assessment";
  assert.equal(await sync(assemblePrices(declared, {}), T0), 1);
  assert.equal(await priceAt(a.workspace.id, action, T0), "1 lead v1");
  const env = { PRICE_QUALIFICATION_ASSESSMENT: "0.5" };
  assert.equal(await sync(assemblePrices(declared, env), day(1)), 2);
  assert.equal(await priceAt(a.workspace.id, action, day(1)), "0.5 lead v2");
  assert.equal(await sync(assemblePrices(declared, env), day(2)), 2);
  assert.equal(await asRole("billing_writer").priceListEntry.count(), 2);
});

test("unchanged prices write nothing; an addition and a drop, 0 included, apply at the start that declares them", async () => {
  const [a] = await createTwoWorkspaces();
  const said = logged();
  assert.equal(await sync(list("test.a 1", "test.b 1"), T0), 1);
  assert.equal(await sync(list("test.b 1", "test.a 1.000"), day(1)), 1);
  assert.equal(await sync(list("test.a 1", "test.b 1", "test.c 2"), day(2)), 2);
  assert.equal(await sync(list("test.a 0.5", "test.b 0", "test.c 2"), day(3)), 3);
  assert.deepEqual(await versions(), [
    version(1, ["test.a 1 lead", "test.b 1 lead"], T0),
    version(2, ["test.a 1 lead", "test.b 1 lead", "test.c 2 lead"], day(2)),
    version(3, ["test.a 0.5 lead", "test.b 0 lead", "test.c 2 lead"], day(3)),
  ]);
  const before = new Date(day(3).getTime() - 1);
  assert.equal(await priceAt(a.workspace.id, "test.a", before), "1 lead v2");
  assert.equal(await priceAt(a.workspace.id, "test.b", day(3)), "0 lead v3");
  assert.equal(await priceAt(a.workspace.id, "test.c", day(3)), "2 lead v3");
  assert.equal(said("credits: prices written").length, 3);
  assert.equal(said("credits: a price rise is announced").length, 0);
});

test("a rise is announced 30 days ahead: the old price until its date, the new one from it; a restart during the notice writes nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const said = logged();
  assert.equal(await sync(list("test.a 1", "test.b 1"), T0), 1);
  assert.equal(await sync(list("test.a 2", "test.b 1"), day(1)), 1);
  assert.equal(await sync(list("test.a 2", "test.b 1"), day(10)), 1);
  assert.deepEqual(await versions(), [
    version(1, ["test.a 1 lead", "test.b 1 lead"], T0),
    version(2, ["test.a 2 lead", "test.b 1 lead"], dateOf(1), day(1)),
  ]);
  const announced = said("credits: a price rise is announced");
  assert.deepEqual(
    announced.map((line) => [line.price_list_version, line.effective_from]),
    [[2, dateOf(1).toISOString()]],
  );
  const before = new Date(dateOf(1).getTime() - 1);
  assert.equal(await priceAt(a.workspace.id, "test.a", before), "1 lead v1");
  assert.equal(await priceAt(a.workspace.id, "test.a", dateOf(1)), "2 lead v2");
  assert.equal(await priceAt(a.workspace.id, "test.b", dateOf(1)), "1 lead v2");
  assert.equal(await sync(list("test.a 2", "test.b 1"), day(40)), 2);
  assert.equal((await versions()).length, 2);
});

test("a rise beside a drop, an addition and a removal: those three apply at once, in a version that keeps the rise's old price; the rise waits for its date", async () => {
  const [a] = await createTwoWorkspaces();
  assert.equal(await sync(list("test.a 1", "test.b 1", "test.d 1"), T0), 1);
  assert.equal(await sync(list("test.a 2", "test.b 0.5", "test.c 3"), day(1)), 2);
  assert.deepEqual(await versions(), [
    version(1, ["test.a 1 lead", "test.b 1 lead", "test.d 1 lead"], T0),
    version(2, ["test.a 1 lead", "test.b 0.5 lead", "test.c 3 lead"], day(1)),
    version(3, ["test.a 2 lead", "test.b 0.5 lead", "test.c 3 lead"], dateOf(1), day(1)),
  ]);
  const id = a.workspace.id;
  assert.equal(await priceAt(id, "test.a", day(1)), "1 lead v2");
  assert.equal(await priceAt(id, "test.b", day(1)), "0.5 lead v2");
  assert.equal(await priceAt(id, "test.c", day(1)), "3 lead v2");
  assert.equal(await priceAt(id, "test.d", T0), "1 lead v1");
  await assert.rejects(priceAt(id, "test.d", day(1)), { code: "credits_input_invalid" });
  assert.equal(await priceAt(id, "test.a", dateOf(1)), "2 lead v3");
});

test("a removal applies at once; another unit is a rise, cheaper or not, and waits for its date", async () => {
  const [a] = await createTwoWorkspaces();
  assert.equal(await sync(list("test.a 1", "test.b 1", "test.c 1"), T0), 1);
  assert.equal(await sync(list("test.a 1", "test.b 1"), day(1)), 2);
  assert.equal(await sync(list("test.a 0.5 profile", "test.b 1"), day(2)), 2);
  assert.deepEqual(await versions(), [
    version(1, ["test.a 1 lead", "test.b 1 lead", "test.c 1 lead"], T0),
    version(2, ["test.a 1 lead", "test.b 1 lead"], day(1)),
    version(3, ["test.a 0.5 profile", "test.b 1 lead"], dateOf(2), day(2)),
  ]);
  const id = a.workspace.id;
  await assert.rejects(priceAt(id, "test.c", day(1)), { code: "credits_input_invalid" });
  assert.equal(await priceAt(id, "test.a", day(3)), "1 lead v2");
  assert.equal(await priceAt(id, "test.a", dateOf(2)), "0.5 profile v3");
});

test("setting a raised price back before its date withdraws the pending version: withdrawn_at is set, next is null, and a reserve after the date charges the old price", async () => {
  const [a] = await createTwoWorkspaces();
  await grantAllowance([a.organization.id], 100);
  const said = logged();
  assert.equal(await sync(list("test.a 1"), T0), 1);
  assert.equal(await sync(list("test.a 2"), day(1)), 1);
  const next = await withTenant(
    { workspaceId: a.workspace.id, principal },
    () => listPrices(tenantClient, day(2)),
    { client: asRole("app") },
  );
  const coming = { credits: "2", unit: "lead", version: 2, effectiveFrom: dateOf(1).toISOString() };
  const shown = { action: "test.a", credits: "1", unit: "lead", version: 1 };
  assert.deepEqual(next.prices, [
    {
      ...shown,
      effectiveFrom: T0.toISOString(),
      next: { ...coming, announcedAt: day(1).toISOString() },
    },
  ]);

  assert.equal(await sync(list("test.a 1"), day(5)), 1);
  assert.deepEqual(await versions(), [
    version(1, ["test.a 1 lead"], T0),
    version(2, ["test.a 2 lead"], dateOf(1), day(1), day(5)),
  ]);
  assert.deepEqual(
    said("credits: a pending price change is withdrawn").map((line) => line.price_list_version),
    [2],
  );
  assert.equal(await sync(list("test.a 1"), day(6)), 1);
  assert.equal(said("credits: a pending price change is withdrawn").length, 1);
  const after = await withTenant(
    { workspaceId: a.workspace.id, principal },
    () => listPrices(tenantClient, day(6)),
    { client: asRole("app") },
  );
  assert.deepEqual(after.prices, [{ ...shown, effectiveFrom: T0.toISOString(), next: null }]);

  const late = dateOf(1);
  const usage = await withTenant(
    { workspaceId: a.workspace.id, principal },
    () =>
      createCreditsClient(() => late).reserve({
        ...{ workspaceId: a.workspace.id, action: "test.a", quantity: 3 },
        ...{ idempotencyKey: "late", subjectRef: "lead_test", lease: "sync" as const },
      }),
    { client: asRole("app") },
  );
  assert.equal(usage.credits, "3");
  const row = await asRole("app").creditUsage.findUniqueOrThrow({ where: { id: usage.usageId } });
  assert.equal(row.priceListVersion, 1);
});

test("a change during a notice withdraws the pending version and announces the declared list with a new 30 days; no rise applies before the date announced for it", async () => {
  const [a] = await createTwoWorkspaces();
  const id = a.workspace.id;
  assert.equal(await sync(list("test.a 1", "test.b 1"), T0), 1);
  assert.equal(await sync(list("test.a 2", "test.b 1"), day(1)), 1);
  assert.equal(await sync(list("test.a 3", "test.b 1"), day(10)), 1);
  assert.equal(await sync(list("test.a 3", "test.b 0.5"), day(20)), 4);
  assert.deepEqual(await versions(), [
    version(1, ["test.a 1 lead", "test.b 1 lead"], T0),
    version(2, ["test.a 2 lead", "test.b 1 lead"], dateOf(1), day(1), day(10)),
    version(3, ["test.a 3 lead", "test.b 1 lead"], dateOf(10), day(10), day(20)),
    version(4, ["test.a 1 lead", "test.b 0.5 lead"], day(20)),
    version(5, ["test.a 3 lead", "test.b 0.5 lead"], dateOf(20), day(20)),
  ]);
  assert.equal(await priceAt(id, "test.a", day(15)), "1 lead v1");
  assert.equal(await priceAt(id, "test.a", dateOf(1)), "1 lead v4");
  assert.equal(await priceAt(id, "test.a", dateOf(10)), "1 lead v4");
  assert.equal(await priceAt(id, "test.b", day(20)), "0.5 lead v4");
  assert.equal(await priceAt(id, "test.a", new Date(dateOf(20).getTime() - 1)), "1 lead v4");
  assert.equal(await priceAt(id, "test.a", dateOf(20)), "3 lead v5");
});

test("the database refuses a withdrawn_at at or after effective_from (23514), and billing_writer updates no other column of price_list (42501)", async () => {
  await sync(list("test.a 1"), T0);
  await sync(list("test.a 2"), day(1));
  const billing = asRole("billing_writer");
  const update = (set: string, version: number) =>
    sqlstate(
      billing.$executeRawUnsafe(`UPDATE "price_list" SET ${set} WHERE "version" = ${version}`),
    );
  assert.equal(await update(`"withdrawn_at" = "effective_from"`, 2), "23514");
  assert.equal(await update(`"withdrawn_at" = "effective_from" + interval '1 day'`, 2), "23514");
  for (const set of [
    `"credits" = 5`,
    `"unit" = 'profile'`,
    `"action" = 'test.b'`,
    `"version" = 9`,
    `"effective_from" = now()`,
    `"announced_at" = now()`,
    `"id" = "id"`,
  ]) {
    assert.equal(await update(set, 2), "42501", set);
  }
  assert.equal(await update(`"withdrawn_at" = "effective_from" - interval '1 day'`, 2), undefined);
});

test("PRICE_SIGNALS_ENGAGER overrides signals.engager, which signals declares at SIGNALS_CREDITS_PER_ENGAGER's credits, 1 by default; a raised override waits for its date, and signals.engager_read keeps its own", async () => {
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
  assert.equal(await sync(assemblePrices([engager, read], {}), T0), 1);
  assert.equal(await sync(assemblePrices([engager, read], env), day(1)), 1);
  const id = a.workspace.id;
  assert.equal(await priceAt(id, "signals.engager", day(1)), "1 engager v1");
  assert.equal(await priceAt(id, "signals.engager", dateOf(1)), "3 engager v2");
  assert.equal(await priceAt(id, "signals.engager_read", dateOf(1)), "1 engagers_30 v2");
});
