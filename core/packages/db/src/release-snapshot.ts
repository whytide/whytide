// The migration set of a release, kept as prisma/releases/<tag>.sql by `pnpm db:release-snapshot <tag>`
// when the release is tagged: every migration of prisma/migrations/, in order, each under a line
// `-- migration: <folder>`. `db:migrate:check` restores a database from the newest snapshot and
// migrates it forward (migrate-check.ts); before the first tag there is no snapshot and the check
// takes the migrations at the merge base with main instead (README "Checks in the pipeline").
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./paths.ts";

/** A release tag, `v0.1.0` or `0.1.0`: no pre-release or build suffix, which would not order. */
const TAG = /^v?\d+\.\d+\.\d+$/;
const SECTION = /^-- migration: (\S+)$/;
const LOCK = "migration_lock.toml";

export const releasesDir = join(packageRoot, "prisma", "releases");
export const migrationsDir = join(packageRoot, "prisma", "migrations");

/** Writes `<releases>/<tag>.sql` from the migrations folder; returns the file's path. */
export function writeReleaseSnapshot(
  tag: string,
  { migrations = migrationsDir, releases = releasesDir } = {},
): string {
  if (!TAG.test(tag)) throw new Error(`"${tag}" is not a release tag, like v0.1.0`);
  const names = migrationFolders(migrations);
  const lines = [
    `-- Whytide release ${tag}: the ${names.length} migration(s) of prisma/migrations at the tag, in order,`,
    "-- written by `pnpm db:release-snapshot`. `pnpm db:migrate:check` restores a database from this file",
    "-- and migrates it forward with the current migrations. Never edited by hand.",
  ];
  for (const name of names) {
    lines.push(
      `-- migration: ${name}`,
      readFileSync(join(migrations, name, "migration.sql"), "utf8").trimEnd(),
    );
  }
  mkdirSync(releases, { recursive: true });
  const file = join(releases, `${tag}.sql`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** The newest snapshot of the folder by version, or undefined before the first tag. */
export function latestReleaseSnapshot(releases = releasesDir): string | undefined {
  if (!existsSync(releases)) return undefined;
  const files = readdirSync(releases).filter((name) => name.endsWith(".sql"));
  const stray = files.find((name) => !TAG.test(name.slice(0, -4)));
  if (stray !== undefined) {
    throw new Error(
      `${join(releases, stray)} is not a release snapshot: the folder holds <tag>.sql files, like v0.1.0.sql, written by pnpm db:release-snapshot`,
    );
  }
  const tags = files.map((name) => name.slice(0, -4)).sort(compareTags);
  const latest = tags.at(-1);
  return latest === undefined ? undefined : join(releases, `${latest}.sql`);
}

/** Unpacks a snapshot into `into` as a migrations folder; returns the migration names in order. */
export function unpackReleaseSnapshot(file: string, into: string): string[] {
  const names: string[] = [];
  let body: string[] | undefined;
  const flush = () => {
    const name = names.at(-1);
    if (name === undefined || body === undefined) return;
    mkdirSync(join(into, name), { recursive: true });
    writeFileSync(join(into, name, "migration.sql"), `${body.join("\n").trimEnd()}\n`);
  };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const section = SECTION.exec(line);
    if (section) {
      flush();
      names.push(section[1] ?? "");
      body = [];
    } else {
      body?.push(line);
    }
  }
  flush();
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, LOCK), readFileSync(join(migrationsDir, LOCK), "utf8"));
  return names;
}

/** The migration folders of a migrations directory, in order; none when it is missing. */
export function migrationFolders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function compareTags(a: string, b: string): number {
  const parts = (tag: string) => tag.replace(/^v/, "").split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}
