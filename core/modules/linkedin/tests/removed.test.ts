// A removed member's accounts (gamma-p6-070; README "Kill switches", docs/flows.md "A member's
// removal"), in this file's schema: tenancy's removeMember publishes tenancy.member_removed, and one
// pass of the outbox's delivery, as the worker's, runs linkedin's subscriber in a tenant run of the
// workspace. The removed user's account there is paused with the source member_removed, one control
// event by the system; a tester's pause is taken over, the operator's kept; its next reservation is
// refused; a teammate's account and the user's account in another workspace stay as they were; a
// redelivery writes nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { createOutboxStore, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, deliverPending, servicePrincipal } from "@whytide/platform";
import { removeMember } from "@whytide/tenancy";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import "../events.ts";
import { setAccountPaused, useClock, useLinkedinClient } from "../testing/index.ts";
import { ALWAYS, sender, THURSDAY } from "./fixtures/send.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useTenancyClient(app);
useClock(() => THURSDAY);
const log = createLogger({ destination: collectLogs().destination });
const worker = servicePrincipal("worker");
const REMOVAL = "system:tenancy.member_removed";

/** One pass of the worker's delivery, each handler in a tenant run of the event's workspace. */
async function deliver(): Promise<number> {
  const report = await deliverPending({
    store: createOutboxStore(app),
    runInTenant: (workspaceId, fn) =>
      withTenant({ workspaceId, principal: worker }, fn, { client: app }),
    log,
  });
  assert.deepEqual([report.retried, report.dead], [0, 0], "every event delivered");
  return report.delivered;
}

/** The account's stop: on, and by whom. */
async function switchOf(id: string) {
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id } });
  return [row.killSwitch, row.killSwitchSource];
}

/** The account stop's events, oldest first: states and actor. */
async function events() {
  const rows = await app.linkedinControlEvent.findMany({ orderBy: [{ at: "asc" }, { id: "asc" }] });
  return rows.map((row) => [
    row.senderAccountId,
    `${row.fromState}>${row.toState}`,
    `${row.actorType}:${row.actor}`,
  ]);
}

test("removing a member pauses their account in the workspace member_removed, one event by the system each, a tester's pause taken over and the operator's kept; the next reservation is refused; a teammate's account and their account elsewhere stay; a redelivery writes nothing", async () => {
  const [a, b] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  /** A new user, a Member of the workspace with an account there. */
  const member = async () => {
    const { id: userId } = await createUser();
    return {
      membership: await createMembership({ userId, workspaceId, role: "Member" }),
      account: await sender("UTC", ALWAYS, { workspaceId, ownerUserId: userId }),
    };
  };
  const [plain, tester, operator, teammate] = [
    await member(),
    await member(),
    await member(),
    await member(),
  ];
  const { userId } = plain.membership;
  await createMembership({ userId, workspaceId: b.workspace.id, role: "Member" });
  const elsewhere = await sender("UTC", ALWAYS, {
    workspaceId: b.workspace.id,
    ownerUserId: userId,
  });
  await setAccountPaused(tester.account.id, "tester");
  await setAccountPaused(operator.account.id, "operator");

  for (const { membership } of [plain, tester, operator]) {
    const removal = { membershipId: membership.id, removedBy: a.user.id };
    await withTenant({ workspaceId, principal: worker }, () => removeMember(removal), {
      client: app,
    });
  }
  assert.equal(await deliver(), 3);

  assert.deepEqual(await switchOf(plain.account.id), [true, "member_removed"]);
  assert.deepEqual(await switchOf(tester.account.id), [true, "member_removed"]);
  assert.deepEqual(await switchOf(operator.account.id), [true, "operator"]);
  assert.deepEqual(await switchOf(teammate.account.id), [false, null]);
  assert.deepEqual(await switchOf(elsewhere.id), [false, null]);
  const paused = [
    [plain.account.id, "off>member_removed", REMOVAL],
    [tester.account.id, "tester>member_removed", REMOVAL],
  ];
  assert.deepEqual(
    (await events()).sort(),
    paused.sort(),
    "one event each, none for the operator's",
  );
  const refused = { refused: "account_stopped", retryAt: null };
  assert.deepEqual(await plain.account.send("after-removal"), refused);
  assert.deepEqual(await plain.account.read(), refused);
  assert.ok("reservationId" in (await elsewhere.send("elsewhere")), "another workspace's sends");

  // A redelivery: the marks lost after the handlers' commits, the rows delivered again.
  await asRole("owner").$executeRawUnsafe("UPDATE outbox SET delivered_at = NULL");
  assert.equal(await deliver(), 3);
  assert.equal((await events()).length, 2, "a redelivery writes nothing");
  assert.deepEqual(await switchOf(tester.account.id), [true, "member_removed"]);
});
