// The safety case of restore.sh (docs/runbook.md "Restore"), `pnpm -F deploy test:safety`. A backup can
// hold sending open, and lose the steps that went out after it, so the restore closes sending through
// linkedin's own command after the restores and before the worker starts; a failed close stops it
// there. restore.sh runs as it is on a fixture backup folder, with a stub of `docker` first on PATH
// that records each call and answers as Compose would: no container runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  BACKUP_FILES,
  CONTROL_COMMAND,
  RESTORE_OPERATOR,
  STARTED_BEFORE_THE_CLOSE,
  STUB_PROJECT,
} from "../constants.ts";
import { deployDir } from "../env-fixture.ts";

type Close = "closed" | "failed" | "silent";
type Call = string[];

const tmp = join(deployDir, "..", ".tmp");
let work = "";

/**
 * docker for restore.sh: each call's arguments on one line of $STUB_LOG, split by the unit separator;
 * the project's name for `config`, no volume, and the close as $STUB_CLOSE says: linkedin's line,
 * a failure, or exit 0 without the line.
 */
const stub = `#!/usr/bin/env bash
set -eu
{ printf '%s\\037' "$@"; printf '\\n'; } >> "$STUB_LOG"
case " $* " in
  *" config "*) echo "name: ${STUB_PROJECT}" ;;
  *" sending close "*)
    case "$STUB_CLOSE" in
      closed) echo "changed: sending closed" ;;
      failed) echo "the database does not answer" >&2; exit 1 ;;
      silent) ;;
    esac ;;
esac
`;

/** restore.sh on the fixture with the stub first on PATH: its exit, its output, docker's calls. */
function restore(close: Close) {
  const log = join(work, `${close}.log`);
  const result = spawnSync("bash", [join(deployDir, "restore.sh"), join(work, "backup")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(work, "bin")}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_CLOSE: close,
    },
  });
  const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : [];
  const calls = lines.filter(Boolean).map((line) => line.split("\x1f").slice(0, -1));
  return { status: result.status, out: result.stdout, err: result.stderr, calls };
}

/** `docker compose -f <deploy>/compose.yaml <command> …`: its command and the rest. */
function composed(call: Call): { command: string; rest: string[] } | null {
  const [docker, file, path, command = "", ...rest] = call;
  if (docker !== "compose") return null;
  assert.deepEqual([file, path], ["-f", join(deployDir, "compose.yaml")], call.join(" "));
  return { command, rest };
}

/** One of the four restores: a database's pg_restore, or MinIO's folder unpacked. */
function isRestore(call: Call): boolean {
  const { command, rest } = composed(call) ?? { command: "", rest: [] };
  if (command === "exec") return rest.includes("pg_restore");
  return command === "run" && rest.includes("tar") && rest.includes("-xf");
}

/** linkedin's close in the api's container, as the operator `restore`. */
function isClose(call: Call): boolean {
  const close = ["exec", "-T", "api", ...CONTROL_COMMAND, "sending", "close"];
  return call.slice(3).join(" ") === [...close, "--operator", RESTORE_OPERATOR].join(" ");
}

/**
 * A call that can start the worker: one that names it, or an `up`, `start`, `restart` or `create`
 * naming none (the whole stack) or any service but those restore.sh starts before the close.
 */
function startsWorker(call: Call): boolean {
  const { command, rest } = composed(call) ?? { command: "", rest: [] };
  if (rest.includes("worker")) return true;
  if (!["up", "start", "restart", "create"].includes(command)) return false;
  const named = rest.filter((arg) => !arg.startsWith("-"));
  return named.length === 0 || named.some((name) => !STARTED_BEFORE_THE_CLOSE.includes(name));
}

/** The positions of the calls `found` picks. */
const at = (calls: Call[], found: (call: Call) => boolean) =>
  calls.flatMap((call, index) => (found(call) ? [index] : []));

before(() => {
  fs.mkdirSync(tmp, { recursive: true });
  work = fs.mkdtempSync(join(tmp, "restore-safety-"));
  fs.mkdirSync(join(work, "bin"));
  fs.writeFileSync(join(work, "bin", "docker"), stub, { mode: 0o755 });
  fs.mkdirSync(join(work, "backup"));
  for (const file of BACKUP_FILES) fs.writeFileSync(join(work, "backup", file), "fixture\n");
});

after(() => fs.rmSync(work, { recursive: true, force: true }));

test("restore.sh closes sending after the restores and before the worker starts", () => {
  const { status, out, err, calls } = restore("closed");
  assert.equal(status, 0, `${err}${out}`);
  const restores = at(calls, isRestore);
  assert.equal(restores.length, 4, "the three databases and MinIO's folder");
  const closes = at(calls, isClose);
  assert.equal(closes.length, 1, "one close");
  const close = closes[0] ?? -1;
  assert.ok(close > Math.max(...restores), "the close comes after the restores");
  const api = at(calls, (call) => composed(call)?.command === "up" && call.at(-1) === "api");
  assert.ok(api.length === 1 && (api[0] ?? -1) > Math.max(...restores), "the api, after them");
  assert.ok((api[0] ?? close) < close, "the api runs the close");
  const starts = at(calls, startsWorker);
  assert.ok(starts.length > 0, "the rest of the stack starts");
  assert.ok(
    starts.every((index) => index > close),
    "nothing can start the worker before the close",
  );
  assert.match(out, /^restore: sending closed$/m);
});

test("a failed close stops the restore with a non-zero exit, the worker never started", () => {
  for (const close of ["failed", "silent"] as const) {
    const { status, err, calls } = restore(close);
    assert.notEqual(status, 0, `${close}: the exit`);
    assert.equal(at(calls, isClose).length, 1, `${close}: the close was asked`);
    assert.deepEqual(calls.filter(startsWorker), [], `${close}: something could start the worker`);
    assert.match(err, /^restore: .*sending/m, `${close}: ${err}`);
  }
});
