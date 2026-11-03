// The tables' own CHECKs, the migration's hand-written SQL (docs/data.md), on a schema of the
// worktree's database, written straight to the tables as `app`: an exit reason exactly on an exited
// enrollment, an end exactly on one no longer active, and a step's quota day a YYYY-MM-DD text, as
// linkedin's. The partial unique keys are the safety cases' (tests/safety/enrollment.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import { ids } from "../ids.ts";

withTestDb();
const app = () => asRole("app");
const CHECK = "23514";
const row = { workspaceId: "wsp_campaigns_tables", personId: "per_tables" };
const template = { templateId: "linkedin_default", templateVersion: 1 };

/** An enrollment, active and started unless `fields` say otherwise. */
const enrollment = (fields: Partial<Prisma.EnrollmentCreateManyInput> = {}) =>
  app().enrollment.create({
    data: {
      ...{ id: newId(ids.enrollment), ...row, ...template, status: "active" },
      ...{ sourceEventId: newId("obx"), startedAt: new Date(), ...fields },
    },
  });

test("an exit reason is set exactly on an exited enrollment, an end exactly on one no longer active", async () => {
  const endedAt = new Date();
  const exited = { status: "exited", exitReason: "suppressed", endedAt } as const;
  assert.equal(await sqlstate(enrollment({ ...exited, exitReason: null })), CHECK, "no reason");
  assert.equal(await sqlstate(enrollment({ exitReason: "removed", endedAt })), CHECK, "active");
  assert.equal(await sqlstate(enrollment({ ...exited, endedAt: null })), CHECK, "no end");
  assert.equal(await sqlstate(enrollment({ endedAt })), CHECK, "an end while active");
  assert.equal(await sqlstate(enrollment({ status: "completed", exitReason: null })), CHECK);
  assert.equal(await sqlstate(enrollment({ ...exited, exitDetail: "opted_out" })), undefined);
  assert.equal(await sqlstate(enrollment({ status: "completed", endedAt })), undefined);
  assert.equal(await sqlstate(enrollment()), undefined);
});

test("a step's quota day is a YYYY-MM-DD text, as linkedin's, or null", async () => {
  const { id: enrollmentId } = await enrollment();
  const step = (stepKey: string, quotaDay: string | null) =>
    app().stepExecution.create({
      data: {
        ...{ id: newId(ids.step_execution), ...row, ...template, enrollmentId, stepKey },
        ...{ senderAccountId: "sac_tables", position: 1, actionType: "invite", quotaDay },
        ...{ stepTemplateHash: stepKey, idempotencyKey: stepKey },
      },
    });
  assert.equal(await sqlstate(step("a", "29/10/2026")), CHECK);
  assert.equal(await sqlstate(step("b", "2026-10-29T10:00")), CHECK);
  assert.equal(await sqlstate(step("c", "2026-10-29")), undefined);
  assert.equal(await sqlstate(step("d", null)), undefined);
});
