// The `app` client the batch uses outside a tenant run, for the tick's read of the workspaces and for
// callAgent's runs: the process's own by default, a test's through useQualificationClient (testing/).
import type { PrismaClient } from "@whytide/db";

let given: PrismaClient | undefined;

/** For tests: `asRole("app")`; undefined puts the process's client back. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

export const givenClient = (): PrismaClient | undefined => given;
