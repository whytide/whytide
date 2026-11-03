// `db:migrate:check`, the pipeline's migration step (docs/rules/delivery.md §4, docs/architecture.md
// §7.6 and §19): every migration expands first (expand-first.ts); the migrations apply from zero on a
// fresh database; a database restored at the previous release migrates forward. The previous release
// is the newest snapshot in prisma/releases/ (release-snapshot.ts) and, before the first tag, the
// migrations at the merge base with main, or at HEAD~1 on main itself. Both runs use one scratch
// database next to the slice's, `<database>_migrate_check`, created and dropped here, so the slice's
// own database is never touched, and both run on an empty schema, no rows: a `SET NOT NULL` over
// existing NULLs, a backfill or a unique index over duplicates passes here and fails on a real
// database; seeding synthetic rows into the restored database is a later task. The working folder is
// `.tmp/<suffix>` under the package, replaced at the start and removed at the end, so a run that died
// leaves nothing the next one does not replace. Run with `pnpm db:migrate:check`;
// tests/migrate-check.test.ts runs it on fixtures.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { databaseUrl } from "./env.ts";
import { checkExpandFirst, formatExpandFirstFinding } from "./expand-first.ts";
import { runMigrations } from "./migrate.ts";
import { writePrismaConfig } from "./migration-set.ts";
import { packageRoot, repositoryRoot } from "./paths.ts";
import {
  latestReleaseSnapshot,
  migrationFolders,
  migrationsDir,
  unpackReleaseSnapshot,
} from "./release-snapshot.ts";
import { databaseOf, dropDatabase, recreateDatabase, withDatabase } from "./reset.ts";

export type MigrateCheckOptions = {
  /** The migrations folder under check; the package's by default. */
  readonly migrations?: string;
  /** The previous release: a snapshot file or a migrations folder; found as the header says by default. */
  readonly previous?: string;
  /** The owner's connection string the scratch database is named after; DATABASE_URL_OWNER by default. */
  readonly ownerUrl?: string;
  /** The scratch database's suffix: `<database>_<suffix>`, `migrate_check` by default. */
  readonly scratch?: string;
  /** Where the progress lines go; nowhere by default. */
  readonly log?: (line: string) => void;
};

export type MigrateCheckReport = {
  /** The migrations applied on the fresh database: every one of the folder. */
  readonly fresh: readonly string[];
  readonly previous: {
    /** Where the previous release came from. */
    readonly source: string;
    /** The migrations of the previous release, restored. */
    readonly restored: readonly string[];
    /** The migrations applied forward on it: the new ones. */
    readonly applied: readonly string[];
  };
};

type PreviousRelease = { readonly source: string; readonly migrations: string };

/** Runs the three checks; throws, naming the check, on the first that fails. */
export async function migrateCheck(options: MigrateCheckOptions = {}): Promise<MigrateCheckReport> {
  const log = options.log ?? (() => undefined);
  const migrations = options.migrations ?? migrationsDir;
  const ownerUrl = options.ownerUrl ?? databaseUrl("owner");
  const suffix = options.scratch ?? "migrate_check";
  const scratch = withDatabase(ownerUrl, `${databaseOf(ownerUrl)}_${suffix}`);
  const tmp = join(packageRoot, ".tmp", suffix);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  let created = false;
  try {
    const findings = checkExpandFirst(migrations);
    if (findings.length) {
      throw new Error(
        `expand-first: ${findings.length} finding(s)\n${findings.map(formatExpandFirstFinding).join("\n")}`,
      );
    }
    const names = migrationFolders(migrations);
    log(`expand-first: ok, ${names.length} migration(s) in ${migrations}`);
    const current =
      migrations === migrationsDir
        ? join(packageRoot, "prisma.config.ts")
        : writePrismaConfig(join(tmp, "current"), migrations);

    await recreateDatabase(scratch);
    created = true;
    const fresh = await stage("fresh database", () =>
      runMigrations({ url: scratch, config: current }),
    );
    if (fresh.join("\n") !== names.join("\n")) {
      throw new Error(
        `fresh database: applied ${fresh.join(", ") || "nothing"}, not the ${names.length} migration(s) of the folder`,
      );
    }
    log(`fresh database: ok, ${fresh.length} migration(s) applied from zero`);

    const previous = previousRelease(options.previous, join(tmp, "previous"));
    await recreateDatabase(scratch);
    const restored = await stage(`previous release (${previous.source}), restoring it`, () =>
      runMigrations({
        url: scratch,
        config: writePrismaConfig(join(tmp, "previous-config"), previous.migrations),
      }),
    );
    const applied = await stage(`previous release (${previous.source}), migrating forward`, () =>
      runMigrations({ url: scratch, config: current }),
    );
    log(
      `previous release: ok, ${restored.length} migration(s) restored from ${previous.source}, ${applied.length} applied forward`,
    );
    return { fresh, previous: { source: previous.source, restored, applied } };
  } finally {
    if (created) await dropDatabase(scratch);
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

/** The previous release's migrations as a folder: the one given, the newest snapshot, or git's. */
function previousRelease(given: string | undefined, dir: string): PreviousRelease {
  const snapshot = given ?? latestReleaseSnapshot();
  if (snapshot !== undefined && statSync(snapshot).isDirectory()) {
    return { source: `the folder ${snapshot}`, migrations: snapshot };
  }
  if (snapshot !== undefined) {
    unpackReleaseSnapshot(snapshot, dir);
    return { source: `the snapshot ${basename(snapshot)}`, migrations: dir };
  }
  return migrationsFromGit(dir);
}

/** The migrations folder as committed at the merge base with main (HEAD~1 on main itself). */
function migrationsFromGit(dir: string): PreviousRelease {
  const main = ["origin/main", "main"].find(
    (ref) => git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]) !== undefined,
  );
  if (main === undefined) {
    throw new Error(
      "previous release: no snapshot in prisma/releases/ and no main to compare with (neither origin/main nor main exists)",
    );
  }
  let base = must(git(["merge-base", "HEAD", main]), `git merge-base HEAD ${main}`);
  let how = `merge base with ${main}`;
  if (base === must(git(["rev-parse", "HEAD"]), "git rev-parse HEAD")) {
    const parent = git(["rev-parse", "--verify", "-q", "HEAD~1^{commit}"]);
    if (parent !== undefined) {
      base = parent;
      how = "HEAD~1";
    }
  }
  const tracked = relative(repositoryRoot, migrationsDir).split("\\").join("/");
  const paths = (git(["ls-tree", "-r", "--name-only", base, "--", tracked]) ?? "")
    .split("\n")
    .filter(Boolean);
  mkdirSync(dir, { recursive: true });
  for (const path of paths) {
    const target = join(dir, relative(tracked, path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      must(git(["show", `${base}:${path}`], false), `git show ${base}:${path}`),
    );
  }
  const files = existsSync(dir) ? paths.length : 0;
  return {
    source: `the migrations at ${base.slice(0, 7)} (${how}${files === 0 ? ", none yet" : ""})`,
    migrations: dir,
  };
}

/** git's output, trimmed unless `trim` is false; undefined when the command fails. */
function git(args: readonly string[], trim = true): string | undefined {
  const run = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (run.status !== 0) return undefined;
  return trim ? run.stdout.trim() : run.stdout;
}

function must(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`previous release: ${what} failed`);
  return value;
}
