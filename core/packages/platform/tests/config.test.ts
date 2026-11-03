// Unit tests of config (alpha-p1-030): the local-schedule type's validation and the env:check
// comparison of deploy/.env.example with the defineConfig blocks; and the package imported without
// APP_ENV, in child processes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkEnv, collectDeclarations } from "../config/env-check.ts";
import { localSchedule } from "../config/index.ts";

const schedule = { timeZone: "Asia/Kolkata", start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] };
const issues = (value: unknown) =>
  localSchedule.safeParse(value).error?.issues.map((issue) => issue.path.join(".")) ?? [];

test("a local schedule is an IANA time zone, HH:mm clock times and distinct ISO weekdays", () => {
  assert.deepEqual(localSchedule.parse(schedule), schedule);
  assert.deepEqual(issues({ ...schedule, timeZone: "Mars/Olympus" }), ["timeZone"]);
  assert.deepEqual(issues({ ...schedule, timeZone: "+05:30" }), ["timeZone"]);
  assert.deepEqual(issues({ ...schedule, start: "9:00" }), ["start"]);
  assert.deepEqual(issues({ ...schedule, end: "24:00" }), ["end"]);
  assert.deepEqual(issues({ ...schedule, start: "18:00", end: "09:00" }), ["end"]);
  assert.deepEqual(issues({ ...schedule, days: [0, 8] }), ["days.0", "days.1"]);
  assert.deepEqual(issues({ ...schedule, days: [1, 1] }), ["days"]);
  assert.deepEqual(issues({ ...schedule, days: [] }), ["days"]);
});

test("env:check compares every block of .env.example with the declarations", () => {
  const root = fileURLToPath(new URL("./fixtures/config/", import.meta.url));
  const declarations = collectDeclarations(root);
  assert.deepEqual(
    declarations.map((d) => `${d.block}:${d.variable}${d.secret ? "#" : ""}`).sort(),
    [
      "modules/sample:C_MODE",
      "modules/sample:D_MISSING",
      "modules/sample:F_TOKEN#",
      "modules/sample:REDIS_URL",
      "packages/platform:A_URL",
      "packages/platform:B_SECRET",
    ],
  );
  const findings = checkEnv(`${root}deploy/.env.example`, declarations);
  const about = (variable: string) => findings.filter((f) => f.includes(variable));
  assert.equal(about("A_URL").length + about("C_MODE").length, 0);
  assert.match(about("D_MISSING").join(), /modules\/sample.*missing from/);
  assert.match(about("E_UNUSED").join(), /nobody declares/);
  assert.match(about("REDIS_URL").join(), /deploy block.*move it/);
  assert.match(about("B_SECRET").join(), /# secret.*not declared with secret\(/);
  assert.match(about("F_TOKEN").join(), /secret\(.*lacks # secret/);
  assert.equal(findings.length, 5, findings.join("\n"));
});

test("importing the package without APP_ENV, with it empty or with another word fails with config_invalid naming it", async () => {
  const root = JSON.stringify(import.meta.resolve("../index.ts"));
  const script = `try { await import(${root}); console.log("imported"); } catch (error) { console.log(JSON.stringify({ code: error.code, details: error.details })); }`;
  const run = async (APP_ENV: string | undefined) => {
    const env = { ...process.env, APP_ENV };
    const argv = ["--input-type=module", "-e", script];
    return (await promisify(execFile)(process.execPath, argv, { env })).stdout;
  };
  const refused = {
    code: "config_invalid",
    details: {
      block: "packages/platform",
      variables: ["APP_ENV: required: development, test or production"],
    },
  };
  const outputs = await Promise.all([undefined, "", "staging"].map(run));
  assert.deepEqual(
    outputs.map((out) => JSON.parse(out)),
    [refused, refused, refused],
  );
  assert.equal(await run("test"), "imported\n");
});
