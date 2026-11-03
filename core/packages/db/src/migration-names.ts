// Migration names: `<module>_<change>` for the person (docs/rules/coding.md §5), which Prisma prefixes
// with a timestamp, so every folder under prisma/migrations/ reads `<timestamp>_<module>_<change>`.
// A module name is lowercase letters and digits; the change is lowercase words joined by `_`.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const NAME = /^[a-z][a-z0-9]*_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const FOLDER = /^\d{14}_[a-z][a-z0-9]*_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** Why `name` is not a migration name, or undefined when it is one. */
export function migrationNameProblem(name: string): string | undefined {
  if (NAME.test(name)) return undefined;
  return `"${name}" is not a migration name: <module>_<change>, lowercase letters, digits and _, like credits_tables`;
}

/** One line per folder of `dir` that is not `<timestamp>_<module>_<change>`; files are not folders. */
export function checkMigrationFolders(dir: string): string[] {
  const problems: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || FOLDER.test(entry.name)) continue;
    problems.push(
      `${join(dir, entry.name)}: a migration folder is <timestamp>_<module>_<change>, like 20261021120000_credits_tables`,
    );
  }
  return problems.sort();
}
