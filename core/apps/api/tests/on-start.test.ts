// The start hook (alpha-p3-050, README "Modules"): a module's onStart runs after the migrations and
// before the api listens, with the host's logger; one that throws, or an onStart that is no function,
// stops the start with module_invalid naming the module and the field, and nothing listens.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, isAppError } from "@whytide/platform";
import type { ModuleLoader, StartHook } from "../src/modules.ts";
import { start } from "../src/start.ts";

const db = withTestDb();
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const probe = (onStart: unknown): ModuleLoader => ({
  name: "probe",
  load: async () => ({ onStart }),
});

/** The host on this file's schema, with its clients. */
function options() {
  const url = new URL(databaseUrl("owner"));
  url.searchParams.set("schema", db.schema);
  const clients = { app: asRole("app"), owner: asRole("owner") };
  return { log, migrations: { url: url.toString() }, clients };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise((done) => server.close(done));
  assert.ok(address && typeof address === "object");
  return address.port;
}

test("onStart runs after the migrations and before the api listens, with the host's logger", async () => {
  const hook: StartHook = async (context) => context.log.info("probe: started");
  const api = await start({ ...options(), port: 0, modules: [probe(hook)] });
  await api.close();
  const steps = ["api: migrations applied", "probe: started", "api: listening"];
  const seen = logs
    .lines()
    .map((line) => String(line.msg))
    .filter((msg) => steps.includes(msg));
  assert.deepEqual(seen, steps);
});

test("an onStart that throws, or is no function, stops the start with module_invalid; nothing listens", async () => {
  const failure = new Error("probe: refused");
  const throwing: StartHook = async () => {
    throw failure;
  };
  for (const onStart of [throwing, "yes"]) {
    const port = await freePort();
    await assert.rejects(start({ ...options(), port, modules: [probe(onStart)] }), (error) => {
      assert.ok(isAppError(error));
      const details = { module: "probe", field: "onStart" };
      assert.deepEqual([error.code, error.details], ["module_invalid", details]);
      assert.equal(error.cause, onStart === throwing ? failure : undefined);
      return true;
    });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health/live`), "something listens");
  }
});
