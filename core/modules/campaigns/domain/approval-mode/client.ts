// The `app` client the approval mode's route opens its own runs on (set.ts changeApprovalMode,
// whytide:own-runs): the process's own, @whytide/db's, by default, a test's through
// useCampaignsClient (testing/).
import type { PrismaClient } from "@whytide/db";

let given: PrismaClient | undefined;

/** For tests: `asRole("app")`; undefined puts the process's client back. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

export const givenClient = (): PrismaClient | undefined => given;
