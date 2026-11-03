// The send tests' fixture (tests/send-reservations.test.ts, tests/safety/): a connected account of a
// new workspace, in a zone and working hours, with its sends, settles and reads, each in a tenant run
// of its own as app, and its day rows; sending open on the instance (each test starts truncated, with
// no platform row). The test file calls withTestDb(), useLinkedinClient and useClock first.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type PrismaClient, withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import type { Day } from "../../domain/quota/days.ts";
import { reserveReads } from "../../domain/quota/reservations.ts";
import { reserveSend } from "../../domain/send/reserve.ts";
import { commitSend, releaseSend } from "../../domain/send/settle.ts";
import type { WorkingHours } from "../../domain/working-hours.ts";
import type { SendActionType } from "../../schemas/quota.ts";
import { createConnectedAccount, openSending } from "../../testing/index.ts";

export const ALWAYS: WorkingHours = { start: "00:00", end: "23:59", days: [1, 2, 3, 4, 5, 6, 7] };
/** Thursday 22 October 2026, 10:00 UTC. */
export const THURSDAY = new Date("2026-10-22T10:00:00Z");
const principal = servicePrincipal("linkedin_test");

type Options = { readonly withNote?: boolean; readonly client?: PrismaClient };
/** createConnectedAccount's settings, and the workspace, a new one's id unless given. */
type Account = Parameters<typeof createConnectedAccount>[1] & { readonly workspaceId?: string };

/** A connected account of a new workspace, or of `account.workspaceId`, and its calls. */
export async function sender(
  timeZone = "UTC",
  workingHours: WorkingHours = ALWAYS,
  account: Account = {},
) {
  const app = asRole("app");
  const { workspaceId = `wsp_test${randomBytes(6).toString("hex")}`, ...settings } = account;
  const { id } = await createConnectedAccount(workspaceId, {
    ...settings,
    timeZone,
    workingHours,
  });
  await openSending();
  const run = <T>(fn: () => Promise<T>, client: PrismaClient = app) =>
    withTenant({ workspaceId, principal }, fn, { client, timeout: 30_000 });
  return {
    id,
    workspaceId,
    run,
    send: (key: string, actionType: SendActionType = "invite", options: Options = {}) => {
      const input = { accountId: id, actionType, idempotencyKey: key, withNote: options.withNote };
      return run(() => reserveSend(input), options.client);
    },
    commit: (reservationId: string) => run(() => commitSend(reservationId)),
    release: (reservationId: string) => run(() => releaseSend(reservationId)),
    read: (count = 1) => run(() => reserveReads({ accountId: id, count, kind: "send_check" })),
    /** The account's day rows, oldest first. */
    days: async (): Promise<Day[]> =>
      app.senderQuotaUsage.findMany({
        where: { senderAccountId: id },
        orderBy: { quotaDay: "asc" },
      }),
  };
}

/** A grant's reservation id; a refusal fails the test, naming it. */
export function granted(answer: { reservationId: string } | { refused: string }): string {
  assert.ok("reservationId" in answer, `refused: ${JSON.stringify(answer)}`);
  return answer.reservationId;
}
