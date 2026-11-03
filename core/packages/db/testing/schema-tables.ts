// The tenant tables of a schema folder that have a column, each with the schema file it sits in, which
// names the module that owns it (README "Tables by column"): privacy's test:tenancy reads the tables
// with a person_id this way, to check that each module holding one registers an eraser. Parsed with
// the schema lint's parser; a tenant table is marked `/// tenant` or has a workspace_id column, as for
// the tenant client (src/tenant-models.ts).
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { packageRoot } from "../src/paths.ts";
import { parseSchema, schemaFiles } from "../src/schema-lint.ts";
import { columnOf } from "../src/tenancy-check.ts";

export type OwnedTable = {
  /** The schema file's name without `.prisma`: the module or package that owns the table. */
  readonly module: string;
  /** The table's name, its `@@map` or else the model's. */
  readonly table: string;
};

const MAP = /^@@map\(\s*(?:name\s*:\s*)?"([^"]*)"/;

/** The tenant tables with the column, in file order; `dir` is prisma/schema unless given. */
export function tenantTablesWithColumn(
  column: string,
  dir: string = join(packageRoot, "prisma", "schema"),
): OwnedTable[] {
  return schemaFiles(dir).flatMap((path) => {
    const module = basename(path, ".prisma");
    return parseSchema(path, readFileSync(path, "utf8"))
      .models.filter((model) => {
        const columns = model.fields.map(columnOf);
        return (model.tenant || columns.includes("workspace_id")) && columns.includes(column);
      })
      .map((model) => {
        const mapped = model.blockAttributes.map((line) => MAP.exec(line)?.[1]).find(Boolean);
        return { module, table: mapped ?? model.name };
      });
  });
}
