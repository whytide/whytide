// The module's workflows and activities, which the worker host registers (core/apps/worker/README.md
// "Modules"; README.md "Worker"): email_revoke_mailbox, after a disconnect by the member or for a
// removed member (events.ts), revokes the tokens through the activity email_revoke_token, then nulls
// them through email_drop_tokens, even when the revoke's attempts ran out; both do nothing for a
// mailbox reconnected since, whose disconnected_at differs. onWorkerStart keeps the host's logger.
import type { TenantClient } from "@whytide/db";
import {
  createLogger,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineWorkflows,
  type Logger,
  workflowInput,
} from "@whytide/platform";
import { z } from "zod";
import { REVOKE_FAILED } from "./constants.ts";
import { type Narrowing, type TokenContext, withMailboxTokens } from "./decrypt.ts";

const revokeInput = workflowInput.extend({
  mailboxId: z.string().min(1).max(64),
  /** The disconnect's time, ISO 8601: a mailbox disconnected at another time is another run's. */
  disconnectedAt: z.iso.datetime(),
});
const dropInput = revokeInput.extend({ revokeFailed: z.boolean() });
/** revoked: the provider took the revoke; gone: the grant was gone already; skipped: reconnected since. */
export type RevokeOutcome = { outcome: "revoked" | "gone" | "skipped" };
let log: Logger | undefined;

/** The disconnect `disconnectedAt` names: a mailbox reconnected, or disconnected again, since misses it. */
const disconnectOf = (disconnectedAt: string) => ({
  status: "disconnected" as const,
  disconnectedAt: new Date(disconnectedAt),
});

/** The mailbox is still disconnected by `disconnect`. */
async function stillDisconnected(context: TokenContext, mailboxId: string, disconnect: Narrowing) {
  const where = { id: mailboxId, ...disconnect };
  const row = await context.tenant((tx) => tx.mailbox.findFirst({ where, select: { id: true } }));
  return row !== null;
}

export const activities = {
  email_revoke_token: defineActivity<typeof revokeInput, RevokeOutcome, TenantClient>({
    kind: "provider",
    input: revokeInput,
    run: async ({ mailboxId, disconnectedAt }, context) => {
      const disconnect = disconnectOf(disconnectedAt);
      if (!(await stillDisconnected(context, mailboxId, disconnect))) {
        return { outcome: "skipped" };
      }
      // The token read holds the same disconnect: a reconnect that committed since the check is missed.
      const answer = await withMailboxTokens(
        context,
        mailboxId,
        async ({ refreshToken }, mailbox) => mailbox.revokeAccess({ refreshToken }),
        "never",
        disconnect,
      );
      if (answer.ok) return { outcome: "revoked" };
      return { outcome: answer.reason === "changed" ? "skipped" : "gone" };
    },
  }),
  email_drop_tokens: defineActivity<typeof dropInput, { dropped: boolean }, TenantClient>({
    kind: "db",
    input: dropInput,
    run: async ({ mailboxId, disconnectedAt, revokeFailed }, context) => {
      const where = {
        id: mailboxId,
        status: "disconnected" as const,
        disconnectedAt: new Date(disconnectedAt),
        oauthTokenRef: { not: null },
      };
      const data = { oauthTokenRef: null };
      const { count } = await context.tenant((tx) => tx.mailbox.updateMany({ where, data }));
      if (revokeFailed) {
        const line = { code: REVOKE_FAILED, mailbox_id: mailboxId };
        (log ??= createLogger()).warn(
          line,
          "email: the revoke failed, the tokens are deleted anyway",
        );
      }
      return { dropped: count === 1 };
    },
  }),
};

export const workflows = defineWorkflows({
  email_revoke_mailbox: { input: revokeInput, taskQueue: DEFAULT_TASK_QUEUE },
});

/** Before the worker polls: the host's logger, for the revoke's warn line. */
export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  log = context.log;
}
