// The commands of this package, behind the root's `pnpm db:*` scripts and `pnpm -F db lint`:
//   node src/cli.ts migrate                       apply the pending migrations as the owner
//   node src/cli.ts migrate-dev --name <m>_<c>    a migration from the schema (migrate-dev.ts)
//   node src/cli.ts reset                         drop and recreate the slice's database, then migrate
//   node src/cli.ts generate                      the client and the tenant model list into generated/
//   node src/cli.ts studio [options]              Prisma Studio on the slice's database, as the owner
//   node src/cli.ts schema-lint [dir]             the schema conventions on prisma/schema
//   node src/cli.ts migrations-check [dir]        every folder of prisma/migrations is well named
//   node src/cli.ts migrate-check                 expand first, a fresh database, the previous release (migrate-check.ts)
//   node src/cli.ts release-snapshot <tag>        prisma/releases/<tag>.sql from the migrations (release-snapshot.ts)
// Node runs the TypeScript directly; the commands that need the generated client import it lazily, so
// the checks run before `prisma generate` ever did. Every call of the Prisma CLI goes through
// prisma() in prisma-cli.ts, which keeps it off the network.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvLocal, packageRoot, repositoryRoot } from "./paths.ts";

// Before a command imports the platform, whose APP_ENV has no default: .env.local's on a laptop, the
// environment's in the GitLab job and a deployment, which win.
loadEnvLocal();
const say = (text: string) => process.stdout.write(`${text}\n`);
const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "migrate": {
      const { runMigrations } = await import("./migrate.ts");
      report(await runMigrations());
      break;
    }
    case "migrate-dev": {
      const { migrateDev } = await import("./migrate-dev.ts");
      process.exitCode = await migrateDev(args);
      break;
    }
    case "reset": {
      const { recreateDatabase } = await import("./reset.ts");
      const { runMigrations } = await import("./migrate.ts");
      say(`database ${await recreateDatabase()} dropped and created again`);
      report(await runMigrations());
      break;
    }
    case "generate": {
      const { generate } = await import("./generate.ts");
      process.exitCode = await generate(args, { say });
      break;
    }
    case "studio": {
      const { prisma } = await import("./prisma-cli.ts");
      const { databaseUrl } = await import("./env.ts");
      const run = await prisma(["studio", ...args], {
        url: databaseUrl("owner"),
        stdio: "inherit",
      });
      process.exitCode = run.code ?? 1;
      break;
    }
    case "schema-lint": {
      const { formatSchemaFinding, lintSchemaFolder } = await import("./schema-lint.ts");
      const findings = lintSchemaFolder(args[0] ?? join(packageRoot, "prisma", "schema"));
      for (const finding of findings) say(formatSchemaFinding(finding));
      say(findings.length ? `${findings.length} schema finding(s)` : "schema: ok");
      process.exitCode = findings.length ? 1 : 0;
      break;
    }
    case "migrate-check": {
      const { migrateCheck } = await import("./migrate-check.ts");
      await migrateCheck({ log: (line) => say(`migrate check: ${line}`) });
      say("migrate check: ok");
      break;
    }
    case "release-snapshot": {
      const { writeReleaseSnapshot } = await import("./release-snapshot.ts");
      if (!args[0]) throw new Error("usage: pnpm db:release-snapshot <tag>, like v0.1.0");
      say(`release snapshot written: ${writeReleaseSnapshot(args[0])}`);
      break;
    }
    case "migrations-check": {
      const { checkMigrationFolders } = await import("./migration-names.ts");
      const problems = checkMigrationFolders(args[0] ?? join(packageRoot, "prisma", "migrations"));
      for (const problem of problems) say(problem);
      say(problems.length ? `${problems.length} migration name(s) wrong` : "migration names: ok");
      process.exitCode = problems.length ? 1 : 0;
      break;
    }
    default:
      process.stderr.write(
        "usage: node src/cli.ts migrate | migrate-dev [--name <module>_<change>] | reset | generate | studio | schema-lint [dir] | migrations-check [dir] | migrate-check | release-snapshot <tag>\n",
      );
      process.exitCode = 2;
  }
} catch (error) {
  // An AppError's details name what failed, config_invalid's the variables, never a value. By its
  // name, as isAppError does for another copy: the platform may be the very import that failed.
  const app = error instanceof Error && error.name === "AppError";
  const details = app ? (error as { details?: unknown }).details : undefined;
  const text = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `db: ${text}${details === undefined ? "" : ` ${JSON.stringify(details)}`}\n`,
  );
  if (app && text === "config_invalid" && !existsSync(join(repositoryRoot, ".env.local"))) {
    process.stderr.write(
      "db: no .env.local: run pnpm env:create for this worktree (deploy/README.md) or set the variables in the environment\n",
    );
  }
  process.exitCode = 1;
}

function report(applied: readonly string[]): void {
  if (applied.length === 0) say("migrations: nothing pending");
  else say(`migrations applied:\n  ${applied.join("\n  ")}`);
}
