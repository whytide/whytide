// The price list (README "Declaring a price", docs/security.md): the actions every module prices with
// definePrices, each overridden by its PRICE_<ACTION> variable, written by the seeder at the api's
// start as billing_writer into price_list, as its next version when anything changed. priceOf reads
// the current version, the highest, in the caller's run.
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

/** A price as price_list holds it: credits per unit as a decimal string. */
export type PriceEntry = {
  readonly action: string;
  readonly credits: string;
  readonly unit: string;
};

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

/**
 * The entries as the current version of price_list, on the seeder's billing_writer client: the same
 * list writes nothing, another one is written whole as the next version. A second api starting at
 * the same moment writes the same rows, which it skips. Returns the current version, null for none.
 */
export async function syncPrices(
  client: PrismaClient,
  entries: readonly PriceEntry[],
  log: Logger,
): Promise<number | null> {
  const latest = (await client.priceListEntry.aggregate({ _max: { version: true } }))._max.version;
  const current = await client.priceListEntry.findMany({ where: { version: latest ?? -1 } });
  const same = (a: readonly PriceEntry[], b: readonly PriceEntry[]) =>
    a.map(key).sort().join("\n") === b.map(key).sort().join("\n");
  if (entries.length === 0 || same(entries, current.map(asEntry))) return latest;
  const version = (latest ?? 0) + 1;
  const effectiveFrom = new Date();
  await client.priceListEntry.createMany({
    data: entries.map((entry) => ({
      id: newId(ids.price_list_entry),
      ...entry,
      version,
      effectiveFrom,
    })),
    skipDuplicates: true,
  });
  log.info({ price_list_version: version, price_count: entries.length }, "credits: prices written");
  return version;
}

/** The action's price in the current version, in the caller's run; credits_input_invalid without one. */
export async function currentPrice(tx: TenantClient, action: string): Promise<CreditsPrice> {
  const version = (await tx.priceListEntry.aggregate({ _max: { version: true } }))._max.version;
  const row =
    version === null
      ? null
      : await tx.priceListEntry.findUnique({ where: { action_version: { action, version } } });
  if (row === null) {
    throw new AppError(errors.credits_input_invalid, { details: { fields: ["action"] } });
  }
  return { ...asEntry(row), version: row.version };
}

function asEntry(row: { action: string; credits: Prisma.Decimal; unit: string }): PriceEntry {
  return { action: row.action, credits: row.credits.toFixed(), unit: row.unit };
}
