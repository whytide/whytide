// The `app` client of the reply golden set's own runs (README.md "The reply golden set"): the
// process's by default, a test's through useInboxExportClient (testing/), which points the route's and
// the command's runs at the test file's schema.
import type { PrismaClient } from "@whytide/db";

let given: PrismaClient | undefined;

/** For tests: `asRole("app")`; undefined puts the process's client back. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

export const givenClient = (): PrismaClient | undefined => given;
