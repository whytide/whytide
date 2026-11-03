// The `app` client of the deletion script's tenant run: the process's own by default, a test's
// through useClient.
import type { PrismaClient } from "@whytide/db";

let given: PrismaClient | undefined;

/** For tests: `asRole("app")`; undefined puts the process's client back. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

export const givenClient = (): PrismaClient | undefined => given;
