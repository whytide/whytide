// email's workflows, run in Temporal's sandbox (README.md "Worker"): ids in, outcomes out.
// email_revoke_mailbox revokes a disconnected mailbox's tokens, then nulls them: once the revoke's
// attempts run out the tokens go anyway, and the drop logs email_revoke_failed; a mailbox reconnected
// since keeps its new tokens.
import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import { ACTIVITY_TIMEOUT } from "./constants.ts";
import type { activities } from "./index.ts";

const { email_drop_tokens, email_revoke_token } = proxyActivities<
  ActivityFunctions<typeof activities>
>({ startToCloseTimeout: ACTIVITY_TIMEOUT });

export async function email_revoke_mailbox(input: {
  workspaceId: string;
  mailboxId: string;
  disconnectedAt: string;
}): Promise<{ outcome: "revoked" | "gone" | "skipped" | "failed"; dropped: boolean }> {
  let outcome: "revoked" | "gone" | "skipped" | "failed";
  try {
    ({ outcome } = await email_revoke_token(input));
  } catch (error) {
    if (isCancellation(error)) throw error;
    outcome = "failed";
  }
  if (outcome === "skipped") return { outcome, dropped: false };
  const { dropped } = await email_drop_tokens({ ...input, revokeFailed: outcome === "failed" });
  return { outcome, dropped };
}
