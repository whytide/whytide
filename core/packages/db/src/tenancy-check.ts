// The tenant rules of the schema (docs/rules/security.md §3, docs/rules/coding.md §5), the first part
// of `test:tenancy`: a model under `/// tenant` has a `workspace_id` column, an index that starts with
// it and `workspace_id` in every unique key; a model with a `/// pii` column holds person data and is
// marked tenant, since a global table holds none (security §1); the pii marker sits above a column,
// never above the model line, so that it names what a deletion script covers. The primary key is not a
// unique key here: ids are `<prefix>_<ULID>`, unique across workspaces by construction. The models come
// from parseSchema() in schema-lint.ts; the pii markers are read here from the text, from the `///`
// lines right above a field (`/// pii`, `/// pii: <class>`, `/// pii:<class>`, any case; `//` lines
// between them and the field are skipped). Run by tests/tenancy.test.ts on prisma/schema and fixtures.
// A model of an excluded schema (`@@schema("mastra")`) is skipped by name (alpha-p1-135).
import { readFileSync } from "node:fs";
import {
  parseSchema,
  type SchemaField,
  type SchemaFile,
  type SchemaFinding,
  schemaFiles,
} from "./schema-lint.ts";

const WORKSPACE_COLUMN = "workspace_id";
/** A `///` line that marks the field under it as person data, with an optional class. */
const PII = /^\s*\/\/\/\s*pii\b(?::\s*\S+)?/i;
/** `@@index([a, b])`, `@@unique(fields: [a], name: "x")`, `@@id([a, b])`: the kind and the field list. */
const KEY = /^@@(index|unique|id)\([^[\]]*\[([^\]]*)\]/;
/**
 * The schemas the rules skip: `mastra` holds Mastra's own tables (core/packages/ai/README.md "The
 * Mastra instance"), workflow snapshots and eval scores without a workspace, never Prisma's.
 */
export const EXCLUDED_SCHEMAS: readonly string[] = ["mastra"];
/** `@@schema("mastra")`: the schema of a model's table. */
const SCHEMA = /^@@schema\(\s*"([^"]*)"\s*\)/;

/** The tenancy findings on one parsed file, `text` being the file's source for the pii markers. */
export function tenancyFindings(file: SchemaFile, text: string): SchemaFinding[] {
  const findings: SchemaFinding[] = [];
  const lines = text.split("\n");
  const found = (line: number, rule: string, message: string) =>
    findings.push({ path: file.path, line, rule, message });
  for (const model of file.models) {
    const schema = model.blockAttributes
      .map((attribute) => SCHEMA.exec(attribute)?.[1])
      .find(Boolean);
    if (schema !== undefined && EXCLUDED_SCHEMAS.includes(schema)) continue;
    const onModel = markerAbove(lines, model.line, PII);
    if (onModel !== undefined) {
      found(
        onModel,
        "pii-on-model",
        `${model.name} is marked /// pii on the model: mark the column that holds the person data, not the model`,
      );
    }
    const pii = model.fields.filter((field) => markerAbove(lines, field.line, PII) !== undefined);
    if (!model.tenant) {
      for (const field of pii) {
        found(
          field.line,
          "pii-tenant",
          `${model.name}.${field.name} is marked /// pii, so ${model.name} is a tenant table: mark it /// tenant; a global table holds no person data`,
        );
      }
      continue;
    }
    const workspace = model.fields.find((field) => columnOf(field) === WORKSPACE_COLUMN);
    if (!workspace) {
      found(
        model.line,
        "tenant-workspace-id",
        `tenant table ${model.name} has no ${WORKSPACE_COLUMN} column: every tenant row carries one`,
      );
      continue;
    }
    if (workspace.optional) {
      found(
        workspace.line,
        "tenant-workspace-id",
        `${model.name}.${workspace.name} is optional: every tenant row carries a ${WORKSPACE_COLUMN}`,
      );
    }
    const keys = model.blockAttributes
      .map((attribute) => KEY.exec(attribute))
      .filter((match) => match !== null)
      .map((match) => ({ kind: match[1] ?? "", fields: fieldsOf(match[2] ?? "") }));
    if (!keys.some((key) => key.fields[0] === workspace.name)) {
      found(
        model.line,
        "tenant-index",
        `tenant table ${model.name} has no index that starts with ${workspace.name}: add @@index([${workspace.name}, …])`,
      );
    }
    for (const key of keys) {
      if (key.kind === "unique" && !key.fields.includes(workspace.name)) {
        found(
          model.line,
          "tenant-unique",
          `${model.name} has a unique key [${key.fields.join(", ")}] without ${workspace.name}: a unique key of a tenant table includes it`,
        );
      }
    }
    for (const field of model.fields) {
      if (field !== workspace && /(?:^|\s)@unique(?:\(|\s|$)/.test(field.attributes)) {
        found(
          field.line,
          "tenant-unique",
          `${model.name}.${field.name} is @unique alone: make it @@unique([${workspace.name}, ${field.name}])`,
        );
      }
    }
  }
  return findings;
}

/** Every *.prisma file of a folder and its subfolders, checked. */
export function checkTenancyFolder(dir: string): SchemaFinding[] {
  return schemaFiles(dir).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return tenancyFindings(parseSchema(path, text), text);
  });
}

/**
 * The column a field maps to: its `@map("…")` or `@map(name: "…")`, or its own name (the tenant
 * client's model list reads it too, src/tenant-models.ts).
 */
export function columnOf(field: SchemaField): string {
  return /@map\(\s*(?:name\s*:\s*)?"([^"]*)"/.exec(field.attributes)?.[1] ?? field.name;
}

/** The field names of `[a, b(sort: Desc), c]`. */
function fieldsOf(list: string): string[] {
  return list
    .split(",")
    .map((entry) => entry.trim().replace(/\(.*$/, ""))
    .filter(Boolean);
}

/**
 * The line of the marker among the comment lines right above `line` (`///` and `//` alike, so a
 * plain comment between the marker and its field hides nothing), or undefined when there is none.
 */
function markerAbove(lines: readonly string[], line: number, marker: RegExp): number | undefined {
  for (let i = line - 2; i >= 0; i--) {
    const raw = lines[i] ?? "";
    if (!/^\s*\/\//.test(raw)) return undefined;
    if (marker.test(raw)) return i + 1;
  }
  return undefined;
}
