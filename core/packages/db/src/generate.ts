// `node src/cli.ts generate`: Prisma's client into generated/, then the tenant model list. The
// packages run it before their `tsc -b`, four at a time under `pnpm -r`, and two Prisma runs at
// once break each other: Prisma empties generated/, then writes it. So one run at a time holds a
// lock folder beside generated/, and Prisma runs only when the hash of what the client is made from
// differs from the stamp of its last complete run, leaving the client as it is for `tsc -b`.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GENERATE_LOCK, GENERATE_POLL_MS, GENERATE_STAMP, GENERATE_WAIT_MS } from "./constants.ts";
import { packageRoot } from "./paths.ts";
import { prisma } from "./prisma-cli.ts";
import { writeModelScopes } from "./tenant-models.ts";

export type GenerateOptions = {
  /** The folder of prisma.config.ts, prisma/schema/ and generated/: this package by default. */
  readonly root?: string;
  /** Runs `prisma generate` with the arguments; its exit code. Prisma's CLI by default. */
  readonly prisma?: (args: readonly string[]) => Promise<number | null>;
  readonly say?: (line: string) => void;
  readonly waitMs?: number;
};

const require = createRequire(import.meta.url);
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;
const runPrisma = async (args: readonly string[]) =>
  (await prisma(["generate", ...args], { stdio: "inherit" })).code;

/** The client unless it is current, then the tenant model list, under the lock; the exit code. */
export async function generate(args: readonly string[], options: GenerateOptions = {}) {
  const root = options.root ?? packageRoot;
  const say = options.say ?? ((line: string) => process.stdout.write(`${line}\n`));
  const generated = join(root, "generated");
  const client = join(generated, "client.ts");
  const stamp = join(generated, GENERATE_STAMP);
  const held = join(root, GENERATE_LOCK);
  await lock(held, options.waitMs ?? GENERATE_WAIT_MS, say);
  try {
    const hash = inputsHash(root, args);
    const made = statSync(client, { throwIfNoEntry: false })?.mtimeMs;
    if (made !== undefined && current(stamp, hash, made)) {
      say("prisma client: current, not generated again");
    } else {
      rmSync(stamp, { force: true });
      // A run killed halfway leaves files but no client.ts, a folder Prisma refuses.
      if (made === undefined) rmSync(generated, { recursive: true, force: true });
      const code = await (options.prisma ?? runPrisma)(args);
      if (code !== 0) return code ?? 1;
      writeFileSync(stamp, hash);
    }
    const out = join(generated, "tenant-models.ts");
    const written = writeModelScopes(join(root, "prisma", "schema"), out);
    say(`tenant model list ${written ? "written" : "unchanged"}: ${out}`);
    return 0;
  } finally {
    rmSync(held, { recursive: true, force: true });
  }
}

/**
 * Whether the stamp holds the hash and is no older than the client, written at `made`: a client
 * written after it, by an older checkout's generate or `prisma generate` by hand, may come from
 * other inputs.
 */
function current(stamp: string, hash: string, made: number): boolean {
  const stamped = statSync(stamp, { throwIfNoEntry: false });
  return stamped !== undefined && made <= stamped.mtimeMs && readFileSync(stamp, "utf8") === hash;
}

/** The sha256 of the schema folder's files, prisma.config.ts, Prisma's versions and the args. */
export function inputsHash(root: string, args: readonly string[]): string {
  const schema = join(root, "prisma", "schema");
  const files = readdirSync(schema, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const versions = ["prisma", "@prisma/client"].map(
    (name) => (require(`${name}/package.json`) as { version: string }).version,
  );
  return sha256(
    JSON.stringify({
      schema: files.map((file) => [relative(schema, file), sha256(readFileSync(file))]),
      config: sha256(readFileSync(join(root, "prisma.config.ts"))),
      versions,
      args,
    }),
  );
}

/**
 * Takes the lock folder, waiting while a live process holds it. Its one file is named by the
 * holder's pid, so that one waiter alone takes over from a process that is gone: the one whose
 * removal of that file succeeds.
 */
async function lock(path: string, waitMs: number, say: (line: string) => void): Promise<void> {
  const mine = join(path, String(process.pid));
  const deadline = Date.now() + waitMs;
  for (let waited = false; ; waited = true) {
    try {
      mkdirSync(path);
      writeFileSync(mine, "");
      return;
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    let holder: string | undefined;
    try {
      holder = readdirSync(path).find((name) => /^\d+$/.test(name));
      if (holder && !alive(Number(holder))) {
        rmSync(join(path, holder));
        writeFileSync(mine, "");
        say(`prisma client: ${path} taken over from pid ${holder}, which is gone`);
        return;
      }
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error; // the lock went, or another waiter took it over
    }
    if (Date.now() > deadline) {
      throw new Error(
        `generate: ${path} is still held by pid ${holder ?? "unknown"} after ${waitMs / 1000} s; remove it if no generate is running`,
      );
    }
    if (!waited) say(`prisma client: waiting for ${path}, held by pid ${holder ?? "unknown"}`);
    await sleep(GENERATE_POLL_MS);
  }
}

/** Whether the process exists: signal 0 sends nothing, and EPERM is another user's process. */
function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return errno(error) === "EPERM";
  }
}
