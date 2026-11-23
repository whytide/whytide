// The tables' own CHECKs, the migration's hand-written SQL (docs/data.md), on a schema of the
// worktree's database, written straight to the tables as `app`: an exit reason exactly on an exited
// enrollment, an end exactly on one no longer active, and a step's quota day a YYYY-MM-DD text, as
// linkedin's; a reply label one of REPLY_ACTION_LABELS with its instant, and a reminder's instant
// and user together, marked sent only when set (gamma-p4-050). The partial unique keys are the
// safety cases' (tests/safety/enrollment.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import { REPLY_ACTION_LABELS } from "../domain/replies/constants.ts";
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

test("a reply label is one of the labels, with its instant; a reminder names its instant and user together, and is sent only once set", async () => {
  const at = new Date();
  const ended = { status: "replied", endedAt: at } as const;
  const labelled = { ...ended, replyLabelAt: at };
  assert.equal(await sqlstate(enrollment({ ...labelled, replyLabel: "maybe" })), CHECK, "off");
  assert.equal(await sqlstate(enrollment({ ...ended, replyLabel: "other" })), CHECK, "no instant");
  assert.equal(await sqlstate(enrollment(labelled)), CHECK, "an instant without a label");
  for (const replyLabel of REPLY_ACTION_LABELS) {
    assert.equal(await sqlstate(enrollment({ ...labelled, replyLabel })), undefined, replyLabel);
  }
  const reminder = { remindAt: at, remindUserId: "usr_tables" };
  assert.equal(await sqlstate(enrollment({ ...ended, remindAt: at })), CHECK, "no user");
  assert.equal(await sqlstate(enrollment({ ...ended, remindUserId: "usr_tables" })), CHECK);
  assert.equal(await sqlstate(enrollment({ ...ended, remindedAt: at })), CHECK, "never set");
  assert.equal(await sqlstate(enrollment({ ...ended, ...reminder })), undefined);
  assert.equal(await sqlstate(enrollment({ ...ended, ...reminder, remindedAt: at })), undefined);
});
