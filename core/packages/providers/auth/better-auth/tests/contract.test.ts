// The Better Auth adapter's contract suite (README.md "Tests"), on a schema of the worktree's database
// (withTestDb, its own client handed to the adapter): a link is followed by requests that do not
// follow redirects, here, in the adapter's folder, where no-raw-fetch allows fetch.
import { before } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { contractSuite } from "../../../testing/index.ts";
import { authCases } from "../../contract.ts";
import { authPort } from "../../port.ts";
import { useAuthDatabase } from "../../testing/index.ts";
import { betterAuthAdapter } from "../index.ts";

withTestDb();
before(() => useAuthDatabase(asRole("app")));
contractSuite(
  authPort,
  betterAuthAdapter,
  authCases(async (url, init) => fetch(url, { ...init, redirect: "manual" })),
);
