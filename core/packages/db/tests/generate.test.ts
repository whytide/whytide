// db's generate (src/generate.ts), each test in a folder of its own under .tmp/ laid out like the
// package, with the stand-in for Prisma of tests/generate-child.ts: the package's own generated/ is
// never touched, since the other test files import that client.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { GENERATE_LOCK } from "../src/constants.ts";
import { generate, inputsHash } from "../src/generate.ts";
import { packageRoot } from "../src/paths.ts";
import { fakePrisma, prismaRuns } from "./generate-child.ts";

const NOTE = "model Note {\n  id String @id\n}\n";
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A folder laid out like the package: a one-model schema, prisma.config.ts, no generated/. */
function packageCopy(): string {
  mkdirSync(join(packageRoot, ".tmp"), { recursive: true });
  const root = mkdtempSync(join(packageRoot, ".tmp", "generate-"));
  roots.push(root);
  mkdirSync(join(root, "prisma", "schema"), { recursive: true });
  writeFileSync(join(root, "prisma", "schema", "notes.prisma"), NOTE);
  writeFileSync(join(root, "prisma.config.ts"), "export default {};\n");
  return root;
}

/** One generate in a process of its own: its exit code and its output. */
const child = (root: string) =>
  new Promise<{ code: unknown; output: string }>((resolve) => {
    const script = join(packageRoot, "tests", "generate-child.ts");
    execFile(process.execPath, [script, root], (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, output: stdout + stderr }),
    );
  });

test("four generates at once with no stamp all exit 0, and Prisma runs once", async () => {
  const root = packageCopy();
  const runs = await Promise.all([1, 2, 3, 4].map(() => child(root)));
  for (const run of runs) assert.equal(run.code, 0, run.output);
  assert.equal(prismaRuns(root), 1);
  const current = runs.filter((run) => run.output.includes("prisma client: current"));
  assert.equal(current.length, 3, "the three others found the client current");
  assert.equal(existsSync(join(root, GENERATE_LOCK)), false, "the lock is released");
});

test("a generate with the stamp current runs no Prisma", async () => {
  const root = packageCopy();
  const lines: string[] = [];
  const options = { root, prisma: fakePrisma(root), say: (line: string) => lines.push(line) };
  assert.equal(await generate([], options), 0);
  assert.equal(await generate([], options), 0);
  assert.equal(prismaRuns(root), 1);
  const list = join(root, "generated", "tenant-models.ts");
  assert.deepEqual(lines, [
    `tenant model list written: ${list}`,
    "prisma client: current, not generated again",
    `tenant model list unchanged: ${list}`,
  ]);
});

test("a client written after the stamp is not current: the next generate runs Prisma", async () => {
  const root = packageCopy();
  const options = { root, prisma: fakePrisma(root), say: () => {} };
  assert.equal(await generate([], options), 0);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, "generated", "client.ts"), later, later);
  assert.equal(await generate([], options), 0);
  assert.equal(prismaRuns(root), 2, "the stamp matched the inputs, but the client was newer");
});

test("a changed input changes the hash, and the next generate runs Prisma", async () => {
  const root = packageCopy();
  const schema = join(root, "prisma", "schema");
  const hashes = [inputsHash(root, []), inputsHash(root, ["--no-hints"])];
  writeFileSync(join(root, "prisma.config.ts"), 'export default { schema: "prisma/schema" };\n');
  hashes.push(inputsHash(root, []));
  mkdirSync(join(schema, "more"));
  writeFileSync(join(schema, "more", "tags.prisma"), NOTE.replace("Note", "Tag"));
  hashes.push(inputsHash(root, []));
  assert.equal(new Set(hashes).size, 4, "the arguments, prisma.config.ts, a file in a subfolder");
  assert.equal(inputsHash(root, []), hashes[3], "the same inputs, the same hash");

  const options = { root, prisma: fakePrisma(root), say: () => {} };
  assert.equal(await generate([], options), 0);
  writeFileSync(join(schema, "notes.prisma"), NOTE.replace("}", "  body String\n}"));
  assert.equal(await generate([], options), 0);
  assert.equal(prismaRuns(root), 2, "the changed schema made a new client");
});

test("a lock left by a process that is gone is taken over; a live one is waited for, then named", async () => {
  const root = packageCopy();
  const lock = join(root, GENERATE_LOCK);
  const options = { root, prisma: fakePrisma(root), say: () => {} };
  mkdirSync(lock);
  writeFileSync(join(lock, String(spawnSync(process.execPath, ["--eval", ""]).pid)), "");
  assert.equal(await generate([], options), 0);
  assert.equal(prismaRuns(root), 1);
  assert.equal(existsSync(lock), false, "released");

  mkdirSync(lock);
  writeFileSync(join(lock, String(process.pid)), "");
  await assert.rejects(generate([], { ...options, waitMs: 300 }), (error: Error) =>
    error.message.includes(lock),
  );
  assert.equal(prismaRuns(root), 1, "no Prisma run without the lock");
});
