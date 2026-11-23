// The price list (README "Declaring a price", docs/security.md, docs/flows.md): the actions every
// module prices with definePrices, each overridden by its PRICE_<ACTION> variable, written by the
// seeder at the api's start as billing_writer into price_list. A version holds the whole list, in
// effect from its effective_from: a new action, a removal and a drop apply at once, a rise waits
// CREDITS_PRICE_CHANGE_NOTICE_DAYS (settings.ts) as the pending version, which a start withdraws once
// the declared list moves off it. The version in effect at an instant is, among the versions not withdrawn whose
// effective_from is at or before it, the latest effective_from, then the highest version; the
// reserve, priceOf and the prices route read it in the caller's run, at the instant they are given.
import { Prisma, type PrismaClient, type TenantClient } from "@whytide/db";
import {
  AppError,
  type CreditsPrice,
  type Logger,
  newId,
  type PriceDefinition,
} from "@whytide/platform";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import type { PricesResponse } from "../schemas/credits.ts";
import { settings } from "../settings.ts";
import { DAY_MS } from "./constants.ts";

/** A price as price_list holds it: credits per unit as a decimal string. */
export type PriceEntry = {
  readonly action: string;
  readonly credits: string;
  readonly unit: string;
};

/** What a start writes: the list in effect at once, and the list it announces; null for none. */
type PricePlan = {
  readonly now: readonly PriceEntry[] | null;
  readonly announce: readonly PriceEntry[] | null;
};

type PriceRow = PriceEntry & { readonly version: number; readonly effectiveFrom: Date };
type Rows = Pick<TenantClient, "priceListEntry">;

const DECIMAL = /^\d{1,20}(?:\.\d{1,12})?$/;

/** `PRICE_` and the action in upper case, a dot written `_`: PRICE_QUALIFICATION_ASSESSMENT. */
export function priceVariable(action: string): string {
  return `PRICE_${action.toUpperCase().replaceAll(".", "_")}`;
}

/**
 * The declared prices, sorted by action, each replaced by its PRICE_<ACTION> variable when that is
 * set: a decimal of zero or more, like `0.5`. A malformed one stops the start with config_invalid,
 * naming the variables, never their values.
 */
export function assemblePrices(
  declared: Iterable<PriceDefinition>,
  env: Readonly<Record<string, string | undefined>>,
): PriceEntry[] {
  const malformed: string[] = [];
  const entries = [...declared].map(({ action, credits, unit }) => {
    const variable = priceVariable(action);
    const value = env[variable]?.trim() ?? "";
    if (value !== "" && !DECIMAL.test(value)) malformed.push(variable);
    return { action, credits: value === "" ? String(credits) : value, unit };
  });
  if (malformed.length > 0) {
    const details = { block: "modules/credits", variables: malformed.sort() };
    throw new AppError("config_invalid", { details });
  }
  return entries.sort((a, b) => (a.action < b.action ? -1 : 1));
}

const key = ({ action, credits, unit }: PriceEntry) =>
  `${action} ${new Prisma.Decimal(credits).toFixed()} ${unit}`;
const same = (a: readonly PriceEntry[], b: readonly PriceEntry[]) =>
  a.map(key).sort().join("\n") === b.map(key).sort().join("\n");
/** More credits for the same unit, or another unit: a rise, which waits (README "Decided here"). */
const rises = (was: PriceEntry, next: PriceEntry) =>
  next.unit !== was.unit || new Prisma.Decimal(next.credits).gt(was.credits);

/**
 * The declared list against the version in effect. `now`: what applies at once, the declared list
 * with each rise kept at its current price, or null when that is the version in effect already, so
 * a new action, a removal and a drop apply at once, also beside a rise. `announce`: the declared
 * list itself when anything in it rises, else null.
 */
function planPrices(current: readonly PriceEntry[], declared: readonly PriceEntry[]): PricePlan {
  const held = new Map(current.map((entry) => [entry.action, entry]));
  let rise = false;
  const atOnce = declared.map((entry) => {
    const was = held.get(entry.action);
    if (was === undefined || !rises(was, entry)) return entry;
    rise = true;
    return was;
  });
  return { now: same(atOnce, current) ? null : atOnce, announce: rise ? declared : null };
}

/** The rows of the version in effect at `at` among `rows`, none withdrawn; none before the first. */
function inEffect<R extends PriceRow>(rows: readonly R[], at: Date): R[] {
  let best: R | undefined;
  for (const row of rows) {
    const from = row.effectiveFrom.getTime();
    if (from > at.getTime()) continue;
    const ahead = best === undefined || from > best.effectiveFrom.getTime();
    if (ahead || (from === best?.effectiveFrom.getTime() && row.version > best.version)) best = row;
  }
  return best === undefined ? [] : rows.filter(({ version }) => version === best.version);
}

/** The version in effect at `at`, in the caller's run or on the seeder's client; null for none. */
async function versionAt(db: Rows, at: Date): Promise<number | null> {
  const row = await db.priceListEntry.findFirst({
    where: { withdrawnAt: null, effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
    select: { version: true },
  });
  return row?.version ?? null;
}

/**
 * The entries as the price list at `now`, on the seeder's billing_writer client, in one transaction:
 * a pending version that is not the list it would announce is withdrawn (`withdrawn_at` = `now`,
 * where it is null); what applies at once is written as the next version, in effect at `now`; a rise
 * is written as the version after, in effect CREDITS_PRICE_CHANGE_NOTICE_DAYS later, announced at
 * `now`, unless the pending version holds exactly the declared list. The same list, during a notice too,
 * writes nothing. A second api starting at the same moment writes the same versions, whose rows the
 * unique key on (action, version) skips. Returns the version in effect at `now`, null for none.
 */
export async function syncPrices(
  client: PrismaClient,
  entries: readonly PriceEntry[],
  log: Logger,
  now: Date = new Date(),
): Promise<number | null> {
  if (entries.length === 0) return versionAt(client, now);
  return client.$transaction(async (tx) => {
    const rows = await tx.priceListEntry.findMany({ orderBy: [{ version: "asc" }] });
    let version = rows.reduce((latest, row) => Math.max(latest, row.version), 0);
    const open = rows.filter((row) => row.withdrawnAt === null).map(asRow);
    const current = inEffect(open, now);
    const plan = planPrices(current, entries);
    let kept = false;
    const pending = new Set(
      open.filter((row) => row.effectiveFrom > now).map((row) => row.version),
    );
    for (const each of pending) {
      const list = open.filter((row) => row.version === each);
      if (!kept && plan.announce !== null && same(list, plan.announce)) {
        kept = true;
        continue;
      }
      const where = { version: each, withdrawnAt: null };
      const { count } = await tx.priceListEntry.updateMany({ where, data: { withdrawnAt: now } });
      if (count > 0) {
        log.info({ price_list_version: each }, "credits: a pending price change is withdrawn");
      }
    }
    const write = (list: readonly PriceEntry[], effectiveFrom: Date, announcedAt: Date | null) => {
      version += 1;
      const data = list.map(({ action, credits, unit }) => ({
        id: newId(ids.price_list_entry),
        ...{ action, credits, unit, version, effectiveFrom, announcedAt },
      }));
      return tx.priceListEntry.createMany({ data, skipDuplicates: true });
    };
    let inForce = current[0]?.version ?? null;
    if (plan.now !== null) {
      await write(plan.now, now, null);
      inForce = version;
      const fields = { price_list_version: version, price_count: plan.now.length };
      log.info(fields, "credits: prices written");
    }
    if (plan.announce !== null && !kept) {
      const notice = settings.CREDITS_PRICE_CHANGE_NOTICE_DAYS * DAY_MS;
      const effectiveFrom = new Date(now.getTime() + notice);
      await write(plan.announce, effectiveFrom, now);
      const fields = { price_list_version: version, effective_from: effectiveFrom.toISOString() };
      log.info(fields, "credits: a price rise is announced");
    }
    return inForce;
  });
}

/**
 * The action's price in the version in effect at `at`, in the caller's run: what the reserve charges
 * and records, and priceOf answers; credits_input_invalid when that version does not price it.
 */
export async function currentPrice(
  tx: TenantClient,
  action: string,
  at: Date,
): Promise<CreditsPrice> {
  const version = await versionAt(tx, at);
  const row =
    version === null
      ? null
      : await tx.priceListEntry.findUnique({ where: { action_version: { action, version } } });
  if (row === null) {
    throw new AppError(errors.credits_input_invalid, { details: { fields: ["action"] } });
  }
  return { ...asEntry(row), version: row.version };
}

/**
 * Every action of the version in effect at `at`, by action, for GET …/credits/prices in the request's
 * run: its price, its version and effective_from, and `next`, the pending version's price of the
 * action when that version changes it, with its date and when it was announced.
 */
export async function listPrices(tx: TenantClient, at: Date): Promise<PricesResponse> {
  const version = await versionAt(tx, at);
  if (version === null) return { prices: [] };
  const rows = await tx.priceListEntry.findMany({ where: { version }, orderBy: { action: "asc" } });
  const pending = await tx.priceListEntry.findFirst({
    where: { withdrawnAt: null, effectiveFrom: { gt: at } },
    orderBy: [{ effectiveFrom: "asc" }, { version: "asc" }],
    select: { version: true },
  });
  const coming =
    pending === null
      ? []
      : await tx.priceListEntry.findMany({ where: { version: pending.version } });
  const nextOf = new Map(coming.map((row) => [row.action, row]));
  const prices = rows.map((row) => {
    const after = nextOf.get(row.action);
    const changes =
      after !== undefined && (after.unit !== row.unit || !after.credits.equals(row.credits));
    const next = changes
      ? {
          credits: after.credits.toFixed(),
          unit: after.unit,
          version: after.version,
          effectiveFrom: after.effectiveFrom.toISOString(),
          announcedAt: after.announcedAt?.toISOString() ?? null,
        }
      : null;
    const { action, credits, unit } = asEntry(row);
    return { action, credits, unit, version, effectiveFrom: row.effectiveFrom.toISOString(), next };
  });
  return { prices };
}

function asEntry(row: { action: string; credits: Prisma.Decimal; unit: string }): PriceEntry {
  return { action: row.action, credits: row.credits.toFixed(), unit: row.unit };
}

function asRow(row: {
  action: string;
  credits: Prisma.Decimal;
  unit: string;
  version: number;
  effectiveFrom: Date;
}): PriceRow {
  return { ...asEntry(row), version: row.version, effectiveFrom: row.effectiveFrom };
}
