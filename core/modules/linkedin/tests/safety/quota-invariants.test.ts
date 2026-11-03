// The safety cases of the send quotas (beta-p1-020; docs/security.md "Budgets"), run by
// `pnpm -F @whytide/linkedin test:safety` and not by `test`: over seeded random sequences of read
// reservations, commits and releases, no day passes its read allowance, the cap at each grant, 100
// reads or the 200 actions; over seeded sequences of sends mixed with reads (beta-p1-030), no day
// passes its send limits or the 200, and no seven quota days 100 connection requests; a day's row
// another run commits between a reservation's lock and its
// read is locked before it is read; the database refuses a limit or a target above its hard
// maximum; the migration brings a read cap of 250 down to 100; and no setting raises a hard maximum.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import {
  createDbClient,
  databaseUrl,
  type PrismaClient,
  runMigrations,
  withTenant,
} from "@whytide/db";
import {
  asRole,
  migrationSet,
  schemaGrantStatements,
  sqlstate,
  withTestDb,
} from "@whytide/db/testing";
import { newId, quotaDay, servicePrincipal, synthetic } from "@whytide/platform";
import { findAccount, updateSettings } from "../../domain/accounts.ts";
import { logAction } from "../../domain/action-log/log.ts";
import {
  ACTIONS_PER_DAY_MAX,
  DAY_LIMIT_DRAW,
  INVITES_PER_DAY,
  INVITES_PER_WEEK,
  MESSAGES_PER_DAY,
  READS_PER_DAY_MAX,
  RESERVATION_MS,
  WEEK_QUOTA_DAYS,
  WITHDRAWALS_PER_DAY_MAX,
} from "../../domain/quota/constants.ts";
import { dayOf } from "../../domain/quota/days.ts";
import { actionsUsed, quotaDayBefore } from "../../domain/quota/limits.ts";
import {
  commitReads,
  type Refusal,
  releaseReads,
  remainingToday,
  reserveReads,
} from "../../domain/quota/reservations.ts";
import { SEND_RESERVATION_MS } from "../../domain/send/constants.ts";
import { reserveSend } from "../../domain/send/reserve.ts";
import { commitSend, releaseSend } from "../../domain/send/settle.ts";
import type { WorkingHours } from "../../domain/working-hours.ts";
import { ids } from "../../ids.ts";
import type { LogInput, SendActionType } from "../../schemas/quota.ts";
import {
  createConnectedAccount,
  openSending,
  useClock,
  useLinkedinClient,
  useRandom,
} from "../../testing/index.ts";

const db = withTestDb();
const app = asRole("app");
useLinkedinClient(app);
const principal = servicePrincipal("linkedin_safety");
let at = new Date();
useClock(() => at);
const ALWAYS: WorkingHours = { start: "00:00", end: "23:59", days: [1, 2, 3, 4, 5, 6, 7] };
const ZONES = ["UTC", "America/Los_Angeles", "Europe/Paris", "Pacific/Auckland", "Asia/Kolkata"];
const SEEDS = [1, 2, 3, 4, 5, 6];
const STEPS = 40;
const MINUTE = 60_000;
/** Each seed's longest step forward: past the hour of a reservation, sometimes past midnight. */
const STEP_MINUTES = 150;
const RESERVE_MAX = 40;
const SEND_STEPS = 100;
const moduleRoot = join(import.meta.dirname, "..", "..");

/** The account's day rows now, each with its reads and every action, reserved and made. */
async function days(accountId: string) {
  const rows = await app.senderQuotaUsage.findMany({ where: { senderAccountId: accountId } });
  return rows.map((row) => ({ ...row, reads: row.readsReserved + row.readsCommitted }));
}

/**
 * One seeded sequence on an account of its own: random targets and cap, then reservations of 1 to 40
 * reads, commits of what a reservation read (never more, before its hour), releases, caps lowered and
 * raised, and the clock moved on, so that holds expire and quota days turn. Each new day's sends are
 * counted first, up to the 200 between them, as a send that went out always is. After every step no
 * day passes its allowance, 100 reads or the 200; after every grant, the day's reads stay within the
 * cap the grant read.
 */
async function sequence(seed: number, seen: Set<string>): Promise<void> {
  const s = synthetic(`linkedin-quota-invariants-${seed}`);
  useRandom(() => s.int(2 ** 32) / 2 ** 32);
  const workspaceId = `wsp_safety${randomBytes(6).toString("hex")}`;
  const timeZone = s.pick(ZONES);
  const { id } = await createConnectedAccount(workspaceId, { timeZone, workingHours: ALWAYS });
  await openSending(); // remainingToday makes the day's rows: it answers nothing while sending is closed
  let cap = 1 + s.int(READS_PER_DAY_MAX);
  const targets = {
    inviteTarget: INVITES_PER_DAY.start + s.int(INVITES_PER_DAY.target - INVITES_PER_DAY.start + 1),
    messageTarget:
      MESSAGES_PER_DAY.start + s.int(MESSAGES_PER_DAY.target - MESSAGES_PER_DAY.start + 1),
  };
  await app.senderAccount.update({ where: { id }, data: { ...targets, dailyReadCap: cap } });
  at = new Date(Date.UTC(2026, 9, 19 + s.int(7), s.int(24), s.int(60)));
  const run = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app, timeout: 30_000 });
  const open: { id: string; count: number; expiresAt: number }[] = [];
  const filled = new Set<string>();
  const take = () => open.splice(s.int(open.length), 1)[0];

  for (let step = 0; step < STEPS; step++) {
    await run(() => remainingToday(id)); // makes the day's row, with its draw, when it is new
    for (const day of await days(id)) {
      if (filled.has(day.id)) continue;
      filled.add(day.id);
      const sends = s.int(ACTIONS_PER_DAY_MAX + 1);
      const invitesCommitted = s.int(sends + 1);
      const messagesCommitted = s.int(sends - invitesCommitted + 1);
      const withdrawalsCommitted = sends - invitesCommitted - messagesCommitted;
      await app.senderQuotaUsage.update({
        where: { id: day.id },
        data: { invitesCommitted, messagesCommitted, withdrawalsCommitted },
      });
    }
    const op = s.int(10);
    if (op < 5) {
      const count = 1 + s.int(RESERVE_MAX);
      const answer = await run(() => reserveReads({ accountId: id, count, kind: "read_profile" }));
      if ("refused" in answer) seen.add(answer.refused);
      else {
        seen.add("granted");
        open.push({ id: answer.reservationId, count, expiresAt: at.getTime() + RESERVATION_MS });
        const date = quotaDay(at, timeZone);
        const day = (await days(id)).find((row) => row.quotaDay === date);
        assert.ok(day, `seed ${seed}, step ${step}: no row holds the grant`);
        const most = Math.min(day.readAllowance, cap);
        assert.ok(day.reads <= most, `seed ${seed}, step ${step}: a grant past the cap it read`);
      }
    } else if (op < 7 && open.length > 0) {
      const held = take();
      if (held) await run(() => commitReads(held.id, s.int(held.count + 1)));
    } else if (op < 8 && open.length > 0) {
      const held = take();
      if (held) await run(() => releaseReads(held.id));
    } else if (op < 9) {
      cap = 1 + s.int(READS_PER_DAY_MAX);
      await run(() => updateSettings(id, { dailyReadCap: cap }));
    } else {
      at = new Date(at.getTime() + s.int(STEP_MINUTES) * MINUTE);
      // A run that never settles in its hour is dead: the next reservation's sweep frees its reads.
      for (let i = open.length - 1; i >= 0; i--) {
        if ((open[i]?.expiresAt ?? 0) <= at.getTime()) open.splice(i, 1);
      }
    }
    for (const day of await days(id)) {
      const where = `seed ${seed}, step ${step}, ${day.quotaDay}`;
      assert.ok(day.reads <= day.readAllowance, `${where}: reads past the allowance`);
      assert.ok(day.readAllowance <= READS_PER_DAY_MAX, `${where}: an allowance above 100`);
      assert.ok(actionsUsed(day) <= ACTIONS_PER_DAY_MAX, `${where}: actions past the 200`);
    }
  }
}

test("over seeded random sequences of read reservations, commits and releases, no day passes its read allowance, the cap at each grant, 100 reads or the 200 actions", async () => {
  const seen = new Set<string>();
  for (const seed of SEEDS) await sequence(seed, seen);
  // Every path ran: grants, and both refusals of a full day.
  const expected: (Refusal["refused"] | "granted")[] = [
    "daily_actions_cap_reached",
    "granted",
    "read_cap_reached",
  ];
  for (const outcome of expected) assert.ok(seen.has(outcome), `no ${outcome} in the sequences`);
});

/**
 * One seeded sequence of sends mixed with reads on an account of its own, in a zone of ZONES: random
 * targets, the six quota days before filled with 40 to 70, or 94 to 100, connection requests,
 * then connection requests (a third with a note), messages and withdrawals under new keys or a key
 * again, reads, commits within the hold, releases, and the clock moved on. After every step no day
 * passes its connection-request, message or withdrawal limit or the 200, and no seven quota days
 * pass 100 connection requests.
 */
async function sendSequence(seed: number, seen: Set<string>): Promise<void> {
  const s = synthetic(`linkedin-send-invariants-${seed}`);
  useRandom(() => s.int(2 ** 32) / 2 ** 32);
  const workspaceId = `wsp_safety${randomBytes(6).toString("hex")}`;
  const timeZone = s.pick(ZONES);
  const { id } = await createConnectedAccount(workspaceId, { timeZone, workingHours: ALWAYS });
  await openSending();
  const targets = {
    inviteTarget: INVITES_PER_DAY.start + s.int(INVITES_PER_DAY.target - INVITES_PER_DAY.start + 1),
    messageTarget:
      MESSAGES_PER_DAY.start + s.int(MESSAGES_PER_DAY.target - MESSAGES_PER_DAY.start + 1),
  };
  await app.senderAccount.update({ where: { id }, data: targets });
  at = new Date(Date.UTC(2026, 9, 19 + s.int(4), s.int(24), s.int(60))); // Monday to Thursday
  const today = quotaDay(at, timeZone);
  // Over the six quota days before, evenly, the rest yesterday: a week nearly full, or half full.
  const before = s.int(3) === 0 ? 94 + s.int(7) : 40 + s.int(31);
  const daily = Math.floor(before / (WEEK_QUOTA_DAYS - 1));
  for (let back = 1; back < WEEK_QUOTA_DAYS; back++) {
    const row = { id: newId(ids.sender_quota_usage), workspaceId, senderAccountId: id, timeZone };
    const invitesCommitted = back === 1 ? before - (WEEK_QUOTA_DAYS - 2) * daily : daily;
    const filled = { inviteLimit: INVITES_PER_DAY.max, invitesCommitted };
    await app.senderQuotaUsage.create({
      data: { ...row, quotaDay: quotaDayBefore(today, back), ...filled },
    });
  }
  const run = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app, timeout: 30_000 });
  const open: { id: string; expiresAt: number; entry: LogInput }[] = [];
  const keys: string[] = [];
  const types: SendActionType[] = ["invite", "invite", "invite", "message", "withdraw"];
  for (let step = 0; step < SEND_STEPS; step++) {
    const op = s.int(12);
    if (op < 6) {
      const again = keys.length > 0 && s.int(4) === 0;
      const idempotencyKey = again ? s.pick(keys) : `key-${seed}-${step}`;
      const actionType = s.pick(types);
      const withNote = actionType === "invite" && s.int(3) === 0;
      const input = { accountId: id, actionType, idempotencyKey, withNote };
      const answer = await run(() => reserveSend(input));
      if ("refused" in answer) seen.add(answer.refused);
      else {
        seen.add(again ? `again ${answer.status}` : answer.status);
        keys.push(idempotencyKey);
        const known = open.some((held) => held.id === answer.reservationId);
        const expiresAt = at.getTime() + SEND_RESERVATION_MS;
        // The `ok` row the send activity writes with the commit (beta-p1-050), naming its step.
        const objectRef = answer.reservationId.replace(/^sqr_/, "sx_");
        const entry = { ...input, kind: actionType, objectRef, count: 1, outcome: "ok" } as const;
        const { idempotencyKey: _key, actionType: _type, ...logged } = entry;
        if (answer.status === "reserved" && !known) {
          open.push({ id: answer.reservationId, expiresAt, entry: logged });
        }
      }
    } else if (op < 8 && open.length > 0) {
      const held = open.splice(s.int(open.length), 1)[0];
      if (held) {
        await run(async () => {
          await commitSend(held.id);
          await logAction(held.entry);
        });
      }
    } else if (op < 9 && open.length > 0) {
      const held = open.splice(s.int(open.length), 1)[0];
      if (held) await run(() => releaseSend(held.id));
    } else if (op < 11) {
      const count = 1 + s.int(RESERVE_MAX);
      const answer = await run(() => reserveReads({ accountId: id, count, kind: "send_check" }));
      if ("reservationId" in answer && s.int(2) === 0) {
        await run(() => commitReads(answer.reservationId, s.int(count + 1)));
      }
    } else {
      at = new Date(at.getTime() + s.int(STEP_MINUTES) * MINUTE);
      // A send never settled within its hold is dead: the next reservation's sweep frees its slot.
      for (let i = open.length - 1; i >= 0; i--) {
        if ((open[i]?.expiresAt ?? 0) <= at.getTime()) open.splice(i, 1);
      }
    }
    const rows = await days(id);
    for (const day of rows) {
      const where = `seed ${seed}, step ${step}, ${day.quotaDay}`;
      const invites = day.invitesReserved + day.invitesCommitted;
      const messages = day.messagesReserved + day.messagesCommitted;
      const withdrawals = day.withdrawalsReserved + day.withdrawalsCommitted;
      assert.ok(invites <= Math.min(day.inviteLimit, INVITES_PER_DAY.max), `${where}: invites`);
      assert.ok(messages <= Math.min(day.messageLimit, MESSAGES_PER_DAY.max), `${where}: messages`);
      assert.ok(withdrawals <= WITHDRAWALS_PER_DAY_MAX, `${where}: withdrawals`);
      assert.ok(actionsUsed(day) <= ACTIONS_PER_DAY_MAX, `${where}: actions past the 200`);
      const first = quotaDayBefore(day.quotaDay, WEEK_QUOTA_DAYS - 1);
      let week = 0;
      for (const other of rows) {
        if (other.quotaDay < first || other.quotaDay > day.quotaDay) continue;
        week += other.invitesReserved + other.invitesCommitted;
      }
      assert.ok(week <= INVITES_PER_WEEK.cap, `${where}: ${week} invites in seven quota days`);
    }
  }
}

test("over seeded random sequences of reserveSend, commitSend and releaseSend mixed with reads, no day passes its connection-request, message or withdrawal limit or the 200, and no seven quota days pass 100 connection requests", async () => {
  const seen = new Set<string>();
  for (const seed of SEEDS) await sendSequence(seed, seen);
  // Every path ran: grants, repeats of a key, and each budget's refusal.
  const expected = [
    "reserved",
    "again reserved",
    "again committed",
    "invite_note_budget",
    "invite_cap_reached",
    "weekly_invite_cap_reached",
  ];
  for (const outcome of expected) assert.ok(seen.has(outcome), `no ${outcome} in the sequences`);
});

test("a day's row another run inserts and commits between a reservation's lock, which found none, and its next statement is locked before it is read: no other connection can lock it, and the other run's draw is kept", async () => {
  useRandom(() => 0.999); // this run's own draw would be 5 connection requests
  const workspaceId = `wsp_safety${randomBytes(6).toString("hex")}`;
  const { id } = await createConnectedAccount(workspaceId, {
    timeZone: "UTC",
    workingHours: ALWAYS,
  });
  at = new Date("2026-10-22T12:00:00Z");
  const other = createDbClient("app", { schema: db.schema });
  const racer = createDbClient("app", { schema: db.schema });
  // The other run: its insert of the day's row, with a draw of its own, held uncommitted.
  const inserted = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<void>();
  const otherRun = other.$transaction(
    async (tx) => {
      await tx.senderQuotaUsage.create({
        data: {
          id: newId(ids.sender_quota_usage),
          workspaceId,
          senderAccountId: id,
          quotaDay: quotaDay(at, "UTC"),
          timeZone: "UTC",
          inviteLimit: 4,
          messageLimit: 8,
          readAllowance: READS_PER_DAY_MAX,
        },
      });
      inserted.resolve();
      await hold.promise;
    },
    { timeout: 30_000 },
  );
  await inserted.promise;
  // This run's client: once a lock of the day's row finds none, the other run commits before this
  // run's next statement, the one interleaving the lock must survive.
  let interleaved = false;
  const client = racer.$extends({
    query: {
      async $allOperations({ model, args, query }) {
        const result = await query(args);
        const sql = model === undefined ? ((args as { strings?: string[] }).strings ?? []) : [];
        const lock = sql.join(" ");
        const none = Array.isArray(result) && result.length === 0;
        if (!interleaved && none && /sender_quota_usage[\s\S]*FOR UPDATE/.test(lock)) {
          interleaved = true;
          hold.resolve();
          await otherRun;
        }
        return result;
      },
    },
  }) as unknown as PrismaClient;
  try {
    const { day, probe } = await withTenant(
      { workspaceId, principal },
      async () => {
        const day = await dayOf(await findAccount(id), at, true);
        const probe = await sqlstate(
          app.$queryRaw`SELECT id FROM sender_quota_usage WHERE id = ${day.id} FOR UPDATE NOWAIT`,
        );
        return { day, probe };
      },
      { client, timeout: 30_000 },
    );
    assert.equal(interleaved, true, "the other run never committed between the two statements");
    assert.equal(probe, "55P03", "the row was not locked when the reservation read it");
    assert.deepEqual([day.inviteLimit, day.messageLimit], [4, 8]);
    assert.equal((await days(id)).length, 1);
  } finally {
    hold.resolve();
    await otherRun.catch(() => undefined);
    await Promise.all([other.$disconnect(), racer.$disconnect()]);
  }
});

test("the database refuses a usage row with invite_limit 26, message_limit 81, read_allowance 101 or limits past the 200 less the withdrawals, a negative counter, and an account with invite_target 16, message_target 41 or daily_read_cap 101", async () => {
  const workspaceId = `wsp_safety${randomBytes(6).toString("hex")}`;
  const { id: senderAccountId } = await createConnectedAccount(workspaceId);
  let day = 0;
  const row = (data: Record<string, number>) =>
    app.senderQuotaUsage.create({
      data: {
        id: newId(ids.sender_quota_usage),
        workspaceId,
        senderAccountId,
        quotaDay: `2026-10-${String(++day).padStart(2, "0")}`,
        timeZone: "UTC",
        ...data,
      },
    });
  const CHECK = "23514";
  assert.equal(await sqlstate(row({ inviteLimit: INVITES_PER_DAY.max + 1 })), CHECK);
  assert.equal(await sqlstate(row({ messageLimit: MESSAGES_PER_DAY.max + 1 })), CHECK);
  assert.equal(await sqlstate(row({ readAllowance: READS_PER_DAY_MAX + 1 })), CHECK);
  const most = { inviteLimit: INVITES_PER_DAY.max, messageLimit: MESSAGES_PER_DAY.max };
  assert.equal(await sqlstate(row({ ...most, readAllowance: 81 })), CHECK, "25 + 80 + 81 > 185");
  assert.equal(await sqlstate(row({ invitesReserved: -1 })), CHECK);
  assert.equal(await sqlstate(row({ withdrawalsCommitted: -1 })), CHECK);
  assert.equal(await sqlstate(row({ ...most, readAllowance: 80 })), undefined, "the maximums hold");

  const account = (data: Record<string, number | string>) =>
    app.senderAccount.update({ where: { id: senderAccountId }, data });
  assert.equal(await sqlstate(account({ inviteTarget: INVITES_PER_DAY.target + 1 })), CHECK);
  assert.equal(await sqlstate(account({ inviteTarget: INVITES_PER_DAY.start - 1 })), CHECK);
  assert.equal(await sqlstate(account({ messageTarget: MESSAGES_PER_DAY.target + 1 })), CHECK);
  assert.equal(await sqlstate(account({ dailyReadCap: READS_PER_DAY_MAX + 1 })), CHECK);
  assert.equal(await sqlstate(account({ rampUpdatedOn: "yesterday" })), CHECK);
  const targets = { inviteTarget: INVITES_PER_DAY.target, messageTarget: MESSAGES_PER_DAY.target };
  assert.equal(await sqlstate(account({ ...targets, rampUpdatedOn: "2026-10-29" })), undefined);
});

test("the migration linkedin_send_quotas brings a daily read cap of 250 down to 100, and gives a day row of before the account's cap, at most 100, as its allowance, with send limits of 0", async () => {
  const set = migrationSet("linkedin-send-quotas");
  const mine = readdirSync(set.migrations).find((name) => name.endsWith("_linkedin_send_quotas"));
  assert.ok(mine, "no migration linkedin_send_quotas");
  const aside = join(set.dir, "aside");
  renameSync(join(set.migrations, mine), aside);
  const schema = `${db.schema}_before`;
  const owner = asRole("owner");
  await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  for (const statement of schemaGrantStatements(schema)) await owner.$executeRawUnsafe(statement);
  const url = new URL(databaseUrl("owner"));
  url.searchParams.set("schema", schema);
  try {
    await runMigrations({ url: url.toString(), config: set.config });
    const accounts = [
      ["sac_before_wide", 250],
      ["sac_before_narrow", 40],
    ] as const;
    for (const [id, cap] of accounts) {
      await owner.$executeRawUnsafe(
        `INSERT INTO "${schema}".sender_accounts (id, workspace_id, owner_user_id, label, provider,
           status, time_zone, working_hours, daily_read_cap, disclosure_acknowledged_at)
         VALUES ($1, 'wsp_before', $2, 'LinkedIn', 'fake', 'connected', 'UTC', '{}', $3, now())`,
        id,
        `usr_${id}`,
        cap,
      );
      await owner.$executeRawUnsafe(
        `INSERT INTO "${schema}".sender_quota_usage (id, workspace_id, sender_account_id, quota_day,
           reads_reserved, reads_committed, time_zone)
         VALUES ($1, 'wsp_before', $2, '2026-10-28', 0, 120, 'UTC')`,
        `squ_${id}`,
        id,
      );
    }
    renameSync(aside, join(set.migrations, mine));
    assert.deepEqual(await runMigrations({ url: url.toString(), config: set.config }), [mine]);
    const after = await owner.$queryRawUnsafe<unknown[]>(
      `SELECT a.id, a.daily_read_cap, a.invite_target, a.message_target, a.ramp_updated_on,
         u.invite_limit, u.message_limit, u.read_allowance, u.reads_committed
       FROM "${schema}".sender_accounts a JOIN "${schema}".sender_quota_usage u
         ON u.sender_account_id = a.id
       ORDER BY a.id`,
    );
    const read = (id: string, cap: number, allowance: number) => ({
      id,
      daily_read_cap: cap,
      invite_target: INVITES_PER_DAY.start,
      message_target: MESSAGES_PER_DAY.start,
      ramp_updated_on: null,
      invite_limit: 0,
      message_limit: 0,
      read_allowance: allowance,
      reads_committed: 120,
    });
    assert.deepEqual(after, [read("sac_before_narrow", 40, 40), read("sac_before_wide", 100, 100)]);
  } finally {
    await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    rmSync(set.dir, { recursive: true, force: true });
  }
});

test("no setting, route or script raises a hard maximum: LINKEDIN_DAILY_READ_CAP_MAX above 100 stops the start with config_invalid; the maximums are declared in domain/quota/constants.ts only, frozen", () => {
  /** The bound as a start with each value reads it, or its error: one process, a fresh import each. */
  const start = (...values: string[]) => {
    const config = JSON.stringify(new URL("../../config.ts", import.meta.url).href);
    const script = [
      "const answers = [];",
      `for (const [index, value] of ${JSON.stringify(values)}.entries()) {`,
      "  process.env.LINKEDIN_DAILY_READ_CAP_MAX = value;",
      "  try {",
      `    const { linkedinConfig } = await import(${config} + "?" + index);`,
      "    answers.push([linkedinConfig.LINKEDIN_DAILY_READ_CAP_MAX]);",
      "  } catch (error) {",
      "    const names = error.details.variables.map((variable) => variable.split(':')[0]);",
      "    answers.push([error.code, error.details.block, names]);",
      "  }",
      "}",
      "console.log(JSON.stringify(answers));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: import.meta.dirname,
      env: { APP_ENV: "test" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const invalid = ["config_invalid", "modules/linkedin", ["LINKEDIN_DAILY_READ_CAP_MAX"]];
  assert.deepEqual(start("150", "101", "1000", "100", "", "40"), [
    invalid,
    invalid,
    invalid,
    [READS_PER_DAY_MAX],
    [READS_PER_DAY_MAX],
    [40],
  ]);

  const names = [
    "INVITES_PER_DAY",
    "MESSAGES_PER_DAY",
    "INVITES_PER_WEEK",
    "WEEK_QUOTA_DAYS",
    "ACTIONS_PER_DAY_MAX",
    "READS_PER_DAY_MAX",
    "WITHDRAWALS_PER_DAY_MAX",
    "DAY_LIMIT_DRAW",
  ];
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+(?:${names.join("|")})\\b`);
  const declaring = sources(moduleRoot).filter((file) =>
    declaration.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(
    declaring.map((file) => relative(moduleRoot, file)),
    [join("domain", "quota", "constants.ts")],
  );
  for (const constant of [INVITES_PER_DAY, MESSAGES_PER_DAY, INVITES_PER_WEEK, DAY_LIMIT_DRAW]) {
    assert.ok(Object.isFrozen(constant));
  }
  assert.throws(() => {
    (INVITES_PER_DAY as { max: number }).max = INVITES_PER_DAY.max + 1;
  }, TypeError);
});

/** The module's own source files, its tests, builds and packages aside. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist", "tests", ".tmp"].includes(entry.name) ? [] : sources(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
