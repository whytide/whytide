// Unit tests of the event registry (alpha-p1-050): dotted snake_case names declared once (the
// duplicate names the fields of both schemas), a closed object of JSON values, the PII field check at
// any depth, subscribe to a declared event only, and publish validating and bounding the payload and
// writing through the caller's transaction (a recording writer here; the database and the delivery
// are tested in core/packages/db).
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { isAppError } from "../errors/index.ts";
import {
  defineEvents,
  EVENT_PAYLOAD_MAX_BYTES,
  type EventName,
  publish,
  registeredEvents,
  registeredSubscribers,
  subscribe,
} from "../events/index.ts";
import type { NewOutboxRow, OutboxWriter } from "../outbox/index.ts";
import { throwsCode } from "../testing/index.ts";

const events = defineEvents({
  "fixture.people_imported": z.object({ import_id: z.string(), person_ids: z.array(z.string()) }),
});
const failsWith = (code: string, details: unknown) => (error: unknown) => {
  assert.ok(isAppError(error), `an AppError, not ${String(error)}`);
  assert.equal(error.code, code);
  assert.deepEqual(error.details, details);
  return true;
};

test("a name is module.event in snake_case segments, an object schema, declared once", () => {
  assert.equal(events["fixture.people_imported"], "fixture.people_imported");
  assert.ok(registeredEvents().has("fixture.people_imported"));
  for (const name of ["PeopleImported", "people", "fixture.people imported", "fixture.", "a..b"]) {
    throwsCode(() => defineEvents({ [name]: z.object({}) }), "invalid_event_name");
  }
  assert.throws(
    () => defineEvents({ "fixture.people_imported": z.object({ list_id: z.string() }) }),
    failsWith("duplicate_event", {
      event: "fixture.people_imported",
      registered_fields: ["import_id", "person_ids"],
      fields: ["list_id"],
    }),
  );
  assert.throws(
    () => defineEvents({ "fixture.scalar": z.string() }),
    failsWith("invalid_event_schema", { event: "fixture.scalar", problem: "not_an_object" }),
  );
  throwsCode(() => defineEvents({ "fixture.list": z.array(z.object({})) }), "invalid_event_schema");
  assert.ok(!registeredEvents().has("fixture.scalar"));
});

test("a schema JSON cannot carry, a transform, an open object or anything-goes fails registration", () => {
  const problems: [string, z.ZodType][] = [
    ["unrepresentable", z.object({ at: z.date() })],
    ["unrepresentable", z.object({ n: z.bigint() })],
    ["unrepresentable", z.object({ m: z.map(z.string(), z.string()) })],
    ["unrepresentable", z.object({ a: z.string().transform((s) => s.length) })],
    ["unrepresentable", z.object({ c: z.custom<string>(() => true) })],
    ["open_fields", z.object({ by_id: z.record(z.string(), z.string()) })],
    ["open_fields", z.object({ a_id: z.string() }).catchall(z.string())],
    ["open_fields", z.looseObject({ a_id: z.string() })],
    ["open_fields", z.object({ j: z.json() })],
    ["anything", z.object({ a: z.any() })],
    ["anything", z.object({ a: z.unknown() })],
    ["anything", z.object({ list: z.array(z.unknown()) })],
  ];
  for (const [problem, schema] of problems) {
    assert.throws(
      () => defineEvents({ "fixture.problem": schema }),
      failsWith("invalid_event_schema", { event: "fixture.problem", problem }),
    );
  }
  assert.ok(!registeredEvents().has("fixture.problem"));
});

test("a payload schema with a field named name, email or linkedin_url fails registration, at any depth", () => {
  for (const field of ["name", "email", "linkedin_url", "firstName", "body", "token"]) {
    assert.throws(
      () =>
        defineEvents({ "fixture.pii": z.object({ person_id: z.string(), [field]: z.string() }) }),
      failsWith("pii_in_event_schema", { event: "fixture.pii", fields: [field] }),
    );
  }
  const nested = {
    person_id: z.string(),
    person: z.object({ email: z.string() }).optional(),
    people: z.array(z.object({ linkedin_url: z.string().nullable() })),
    ref: z.union([z.object({ lead_id: z.string() }), z.object({ name: z.string() })]),
    contact: z.intersection(z.object({ contact_id: z.string() }), z.object({ phone: z.string() })),
    pair: z.tuple([z.object({ list_id: z.string() }), z.object({ headline: z.string() })]),
  };
  assert.throws(
    () => defineEvents({ "fixture.nested": z.object(nested) }),
    failsWith("pii_in_event_schema", {
      event: "fixture.nested",
      fields: ["email", "linkedin_url", "name", "phone", "headline"],
    }),
  );
  assert.ok(!registeredEvents().has("fixture.nested"));
  const ids = defineEvents({
    "fixture.ids_only": z.object({
      person_id: z.string(),
      lead_ids: z.array(z.string()),
      list: z.object({ list_id: z.string() }).nullable(),
      imported_count: z.number().int(),
      at: z.iso.datetime().optional(),
      state: z.enum(["queued", "done"]).default("queued"),
    }),
  });
  assert.equal(ids["fixture.ids_only"], "fixture.ids_only");
});

test("subscribe wants a declared event; publish validates the payload and writes the row in the caller's transaction", async () => {
  throwsCode(() => subscribe("fixture.unknown" as EventName, () => {}), "unknown_event");
  const handler = async () => {};
  subscribe(events["fixture.people_imported"], handler);
  assert.deepEqual(registeredSubscribers().get("fixture.people_imported"), [handler]);

  const rows: NewOutboxRow[] = [];
  const tx: OutboxWriter = {
    workspaceId: "wsp_fixture",
    insertOutbox: async (row) => {
      rows.push(row);
    },
  };
  const payload = { import_id: "imp_1", person_ids: ["per_1", "per_2"] };
  const id = await publish(tx, events["fixture.people_imported"], payload);
  assert.match(id, /^obx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  const row = rows[0];
  assert.ok(row);
  assert.deepEqual(row, {
    id,
    workspaceId: "wsp_fixture",
    eventName: "fixture.people_imported",
    payload,
    createdAt: row.createdAt,
    nextAttemptAt: row.createdAt,
  });
  assert.ok(row.createdAt instanceof Date);

  await assert.rejects(
    publish(tx, events["fixture.people_imported"], {
      import_id: "imp_2",
      person_ids: "per_1",
    } as never),
    failsWith("invalid_event_payload", {
      event: "fixture.people_imported",
      issues: ["person_ids"],
    }),
  );
  await assert.rejects(
    publish(tx, "fixture.unknown" as EventName, {}),
    failsWith("unknown_event", { event: "fixture.unknown" }),
  );
  const heavy = Array.from({ length: 20_000 }, (_, i) => `per_${String(i).padStart(22, "0")}`);
  await assert.rejects(
    publish(tx, events["fixture.people_imported"], { import_id: "imp_3", person_ids: heavy }),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "event_payload_too_large");
      assert.equal(error.status, 413);
      assert.equal(error.details?.limit_bytes, EVENT_PAYLOAD_MAX_BYTES);
      assert.ok(Number(error.details?.payload_bytes) > EVENT_PAYLOAD_MAX_BYTES);
      return true;
    },
  );
  assert.equal(rows.length, 1, "a refused publish writes nothing");
});
