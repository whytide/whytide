// Expand first (docs/architecture.md §7.6, docs/rules/coding.md §5): a migration adds, and removes or
// renames only what no running release reads any more. A `DROP TABLE`, a column drop (`DROP COLUMN`,
// or `DROP <column>` in an ALTER TABLE), a `RENAME [COLUMN] <column> TO …` or a table's `RENAME TO …`
// is a contraction, allowed when the comment lines right above the statement carry
// `-- contract: <release> …`, naming the release that stopped using it, like
// `-- contract: v0.3.0 stopped reading persons.full_name`; one marker covers the one statement under
// it. `ALTER COLUMN … TYPE`, `SET NOT NULL` and `ALTER TYPE … RENAME` are not read as contractions
// (README "Checks in the pipeline"). The statements come from sql-statements.ts, so a drop inside a
// comment, a string or a DO block is text. `db:migrate:check` runs this on every migration of the
// folder (migrate-check.ts); tests/expand-first.test.ts is the unit test.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sqlStatements } from "./sql-statements.ts";

export type Contraction = "DROP TABLE" | "DROP COLUMN" | "RENAME TABLE" | "RENAME COLUMN";

export type ExpandFirstFinding = {
  /** The migration.sql file. */
  readonly path: string;
  /** The statement's first line. */
  readonly line: number;
  readonly statement: Contraction;
  readonly message: string;
};

const MARKER = /^\s*--\s*contract\b[:\s]*(.*)$/i;
/** `v0.3.0`, `V0.3.0` or `0.3.0`, somewhere in the marker. */
const RELEASE = /\bv?\d+\.\d+\.\d+\b/i;
/** Each contraction's shape, matched against a statement without comments and literals. */
const CONTRACTIONS: readonly (readonly [Contraction, RegExp])[] = [
  ["DROP TABLE", /^DROP\s+TABLE\b/i],
  // `DROP COLUMN x`, or `DROP x` where x is a column: not a constraint, a default, NOT NULL, an
  // identity or an expression.
  [
    "DROP COLUMN",
    /^ALTER\s+TABLE\b[\s\S]*?\bDROP\s+(?:COLUMN\b|(?!CONSTRAINT\b|DEFAULT\b|NOT\b|IDENTITY\b|EXPRESSION\b)(?:IF\s+EXISTS\s+)?"?[A-Za-z_])/i,
  ],
  ["RENAME TABLE", /^ALTER\s+TABLE\b[\s\S]*?\bRENAME\s+TO\b/i],
  // `RENAME COLUMN x TO y` or `RENAME x TO y`; a constraint's rename is not a contraction.
  [
    "RENAME COLUMN",
    /^ALTER\s+TABLE\b[\s\S]*?\bRENAME\s+(?:COLUMN\s+)?(?!CONSTRAINT\b|TO\b)(?:"[^"]*"|[A-Za-z_]\w*)\s+TO\b/i,
  ],
];

/** The contractions of one migration's SQL that no attached `-- contract: <release>` line allows. */
export function expandFirstFindings(path: string, sql: string): ExpandFirstFinding[] {
  const findings: ExpandFirstFinding[] = [];
  for (const statement of sqlStatements(sql)) {
    const kind = CONTRACTIONS.find(([, shape]) => shape.test(statement.text))?.[0];
    if (kind === undefined) continue;
    const marker = statement.comments.map((c) => MARKER.exec(c)?.[1]).find((m) => m !== undefined);
    if (marker === undefined) {
      findings.push({
        path,
        line: statement.line,
        statement: kind,
        message: `${kind} without a "-- contract: <release>" line above it: a migration expands first and contracts what the release named stopped using`,
      });
    } else if (!RELEASE.test(marker)) {
      findings.push({
        path,
        line: statement.line,
        statement: kind,
        message: `the "-- contract" line names no release that made this ${kind} safe (like v0.3.0)`,
      });
    }
  }
  return findings;
}

/** Every migration.sql under a migrations folder, checked; nothing when the folder is missing. */
export function checkExpandFirst(dir: string): ExpandFirstFinding[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, "migration.sql"))
    .filter((file) => existsSync(file))
    .sort()
    .flatMap((file) => expandFirstFindings(file, readFileSync(file, "utf8")));
}

/** `path:line expand-first message`, the shape of the lint's findings. */
export function formatExpandFirstFinding(finding: ExpandFirstFinding): string {
  return `${finding.path}:${finding.line} expand-first ${finding.message}`;
}
