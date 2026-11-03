// Events between modules (architecture §4.3 rule 4, §7.6; coding §2, §3): a module declares its events
// in its events.ts with defineEvents, publishes one with publish() inside the transaction of the
// change, and another module subscribes in its own events.ts. The row goes to the outbox table and the
// worker delivers it (../outbox/index.ts); a publisher never calls a subscriber. Payloads carry ids
// only: a schema with a field named in the PII registry fails registration, so does one that JSON
// cannot carry or that admits undeclared keys (fields.ts).
import type { z } from "zod";
import { AppError, defineErrors } from "../errors/index.ts";
import { newId, platformIds } from "../ids/index.ts";
import { piiKeys } from "../logging/pii.ts";
import type { OutboxWriter } from "../outbox/store.ts";
import { analyzeEventSchema } from "./fields.ts";

declare const payloadType: unique symbol;
/** An event's name as defineEvents returns it: the string, carrying the payload type for publish and subscribe. */
export type EventName<P = unknown> = string & { readonly [payloadType]?: P };
type Names<T extends Record<string, z.ZodType>> = {
  readonly [K in keyof T & string]: EventName<z.infer<T[K]>>;
};
export type EventPayload = Readonly<Record<string, unknown>>;

/** What a handler gets besides the payload; `tx` is the tenant transaction the runner opened for the event's workspace. */
export type EventContext<Tx = unknown> = {
  readonly id: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly createdAt: Date;
  /** 1 on the first delivery: a handler that sees a later attempt dedupes by `id`. */
  readonly attempt: number;
  readonly tx: Tx;
};
export type EventHandler<P = unknown, Tx = unknown> = (
  payload: P,
  context: EventContext<Tx>,
) => Promise<void> | void;

const errors = defineErrors({
  invalid_event_name: {},
  duplicate_event: {},
  invalid_event_schema: {},
  pii_in_event_schema: {},
  unknown_event: {},
  invalid_event_payload: { status: 400 },
  event_payload_too_large: { status: 413 },
});
const SEGMENT = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";
const NAME = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})+$`);
/** The most a payload may weigh as JSON: ids and counts never come near it. */
export const EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;
const pii = new Set(piiKeys);
const events = new Map<string, z.ZodType>();
const subscribers = new Map<string, EventHandler[]>();

/**
 * Registers `{ "module.event_name": payloadSchema }` pairs; returns the names as themselves, typed with
 * their payload, so `publish(tx, events["people.imported"], payload)` is checked. A name that is not
 * dotted snake_case, one declared twice (the details name the fields of both schemas), a schema that
 * is not a closed object of JSON values (`invalid_event_schema`, with the problem), or one with a field
 * of the PII registry at any depth fails at start.
 */
export function defineEvents<const T extends Record<string, z.ZodType>>(definitions: T): Names<T> {
  for (const [name, schema] of Object.entries(definitions)) {
    if (!NAME.test(name))
      throw new AppError(errors.invalid_event_name, { details: { event: name } });
    const registered = events.get(name);
    const { fields, problem } = analyzeEventSchema(schema);
    if (registered) {
      const details = {
        event: name,
        registered_fields: analyzeEventSchema(registered).fields,
        fields,
      };
      throw new AppError(errors.duplicate_event, { details });
    }
    if (problem) {
      throw new AppError(errors.invalid_event_schema, { details: { event: name, problem } });
    }
    const personal = fields.filter((field) => pii.has(field));
    if (personal.length) {
      throw new AppError(errors.pii_in_event_schema, {
        details: { event: name, fields: personal },
      });
    }
    events.set(name, schema);
  }
  const names = Object.keys(definitions).map((name) => [name, name]);
  return Object.freeze(Object.fromEntries(names)) as Names<T>;
}

export const registeredEvents = (): ReadonlyMap<string, z.ZodType> => events;
export const registeredSubscribers = (): ReadonlyMap<string, readonly EventHandler[]> =>
  subscribers;
export const subscribersOf = (name: string): readonly EventHandler[] => subscribers.get(name) ?? [];

/**
 * Registers a handler for a declared event (import the publisher's `events` from its index.ts: that
 * declares it first). The worker calls it with the payload and a tenant transaction for the event's
 * workspace, at least once per event.
 */
export function subscribe<P, Tx = unknown>(name: EventName<P>, handler: EventHandler<P, Tx>): void {
  if (!events.has(name)) throw new AppError(errors.unknown_event, { details: { event: name } });
  subscribers.set(name, [...subscribersOf(name), handler as EventHandler]);
}

/** The payload as the event's schema reads it; `unknown_event` or `invalid_event_payload` (the paths, never a value). */
export function parseEventPayload(name: string, payload: unknown): EventPayload {
  const schema = events.get(name);
  if (!schema) throw new AppError(errors.unknown_event, { details: { event: name } });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.path.map(String).join("."));
    throw new AppError(errors.invalid_event_payload, { details: { event: name, issues } });
  }
  return parsed.data as EventPayload;
}

/**
 * Validates the payload and writes the outbox row inside `tx`, the caller's tenant transaction, so the
 * event exists exactly when the change does; returns the event id. Nothing is delivered here.
 */
export async function publish<P>(
  tx: OutboxWriter,
  name: EventName<P>,
  payload: P,
): Promise<string> {
  const parsed = parseEventPayload(name, payload);
  const bytes = Buffer.byteLength(JSON.stringify(parsed));
  if (bytes > EVENT_PAYLOAD_MAX_BYTES) {
    const details = { event: name, payload_bytes: bytes, limit_bytes: EVENT_PAYLOAD_MAX_BYTES };
    throw new AppError(errors.event_payload_too_large, { details });
  }
  const id = newId(platformIds.outbox_entry);
  const createdAt = new Date();
  await tx.insertOutbox({
    id,
    workspaceId: tx.workspaceId,
    eventName: name,
    payload: parsed,
    createdAt,
    nextAttemptAt: createdAt,
  });
  return id;
}
