// Prefixed, time-sortable ids, `<prefix>_<ULID>` (requirements, data model §2.2; coding §5). A module
// declares its prefixes in its ids.ts with defineIds; the registry assembled from them is what newId
// accepts. The ULID is 48 bits of milliseconds and 80 random bits in Crockford base32, incremented
// inside one millisecond, so ids made by one process never collide and always sort by creation.
import { randomBytes } from "node:crypto";
import { AppError, defineErrors } from "../errors/index.ts";

export type Id<P extends string = string> = `${P}_${string}`;
export type ParsedId<P extends string> = {
  readonly prefix: P;
  readonly ulid: string;
  readonly time: Date;
};
type Prefixes<T extends Record<string, string>> = { readonly [K in keyof T as T[K]]: K & string };

const errors = defineErrors({
  invalid_id: {},
  invalid_prefix: {},
  duplicate_prefix: {},
  unknown_prefix: {},
});
const PREFIX = /^[a-z][a-z0-9]{1,7}$/;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const registry = new Map<string, string>();
let lastTime = 0;
let lastRandom = 0n;

/** Registers `{ prefix: entity }` pairs; returns `{ entity: prefix }`, so `newId(ids.person)` reads well. */
export function defineIds<const T extends Record<string, string>>(prefixes: T): Prefixes<T> {
  for (const [prefix, entity] of Object.entries(prefixes)) {
    if (!PREFIX.test(prefix)) throw new AppError(errors.invalid_prefix, { details: { prefix } });
    if (registry.has(prefix)) throw new AppError(errors.duplicate_prefix, { details: { prefix } });
    registry.set(prefix, entity);
  }
  const byEntity = Object.entries(prefixes).map(([prefix, entity]) => [entity, prefix]);
  return Object.freeze(Object.fromEntries(byEntity)) as Prefixes<T>;
}

export const registeredPrefixes = (): ReadonlyMap<string, string> => registry;

export function newId<P extends string>(prefix: P): Id<P> {
  if (!registry.has(prefix)) throw new AppError(errors.unknown_prefix, { details: { prefix } });
  return `${prefix}_${ulid()}`;
}

/** The id's parts, or `invalid_id` when the prefix is not the expected one or the ULID is malformed. */
export function parseId<P extends string>(value: string, prefix: P): ParsedId<P> {
  const separator = value.indexOf("_");
  const ulid = value.slice(separator + 1);
  if (separator === -1 || value.slice(0, separator) !== prefix || !ULID.test(ulid)) {
    throw new AppError(errors.invalid_id, { details: { expected: prefix } });
  }
  return { prefix, ulid, time: new Date(decode(ulid.slice(0, 10))) };
}

function ulid(): string {
  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
    lastRandom = BigInt(`0x${randomBytes(10).toString("hex")}`);
  } else {
    lastRandom += 1n;
  }
  let value = (BigInt(lastTime) << 80n) | lastRandom;
  let text = "";
  for (let i = 0; i < 26; i++) {
    text = ALPHABET.charAt(Number(value & 31n)) + text;
    value >>= 5n;
  }
  return text;
}

function decode(text: string): number {
  let value = 0;
  for (const char of text) value = value * 32 + ALPHABET.indexOf(char);
  return value;
}

/** The platform's own prefixes: the outbox, cost events, idempotency records, decision records. */
export const platformIds = defineIds({
  obx: "outbox_entry",
  cost: "cost_event",
  idem: "idempotency_record",
  dec: "decision_record",
});
