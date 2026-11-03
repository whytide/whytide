// The adapter's database client: the `app` role's, made when the adapter starts, unless a test handed
// in its own schema's client first through useAuthDatabase (@whytide/providers/auth/testing). No
// import of Better Auth here, so that the test helpers load no vendor SDK.
import type { PrismaClient } from "@whytide/db";

let given: PrismaClient | undefined;

/** The client the adapter uses from its next start on: a test's, as asRole("app") gives it. */
export function useAuthDatabase(client: PrismaClient): void {
  given = client;
}

export const givenAuthDatabase = (): PrismaClient | undefined => given;
