// The schema lint: the conventions of docs/rules/coding.md §5 and the data model (requirements
// 05 §2.2, §2.3) that Prisma's own validation does not enforce. Every model maps to a snake_case
// table (`@@map`), every column with an upper-case letter in its name maps to a snake_case column
// (`@map`), every DateTime is `@db.Timestamptz` (UTC instants), and an `@id` is a `String` without a
// default, because the platform generates `<prefix>_<ULID>` ids. A vendor's id never sits in a domain
// column: it goes to the jsonb column `provider_refs`, keyed by adapter name (architecture §9 rule 5,
// `setProviderRef` in core/packages/providers), or to the adapter's own table. A model under a
// `/// tenant` doc comment is a tenant table: alpha-p1-020 lists those. Run with
// `node src/cli.ts schema-lint [dir]`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SchemaField = {
  readonly name: string;
  /** The type without `?` and `[]`. */
  readonly type: string;
  readonly list: boolean;
  readonly optional: boolean;
  /** Everything after the type: the field's attributes. */
  readonly attributes: string;
  readonly line: number;
};

export type SchemaModel = {
  readonly name: string;
  readonly line: number;
  /** Marked `/// tenant` in the line before it. */
  readonly tenant: boolean;
  readonly fields: readonly SchemaField[];
  /** The `@@…` lines of the model. */
  readonly blockAttributes: readonly string[];
};

export type SchemaFile = {
  readonly path: string;
  readonly models: readonly SchemaModel[];
  readonly enums: readonly string[];
};

export type SchemaFinding = {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
};

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/** The vendors whose ids a domain column may not carry; an adapter's own table is named `<vendor>_…`. */
const VENDORS = ["unipile", "stripe", "razorpay", "hubspot"];
const VENDOR_ID = new RegExp(`(?:^|_)(${VENDORS.join("|")})(?:_[a-z0-9]+)*_id$`);
const snakeCase = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** The models and enums of one schema file; attributes are kept as text. */
export function parseSchema(path: string, text: string): SchemaFile {
  const models: SchemaModel[] = [];
  const enums: string[] = [];
  let open: { name: string; kind: string; line: number; tenant: boolean } | undefined;
  let fields: SchemaField[] = [];
  let blockAttributes: string[] = [];
  let tenantNext = false;
  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const doc = /^\s*\/\/\/\s*(.*)$/.exec(raw);
    if (doc) {
      if (doc[1]?.trim() === "tenant") tenantNext = true;
      return;
    }
    const code = raw.replace(/\/\/.*$/, "").trim();
    if (code === "") return;
    const start = /^(model|enum|type|view)\s+(\w+)\s*\{/.exec(code);
    if (start && !open) {
      open = { kind: start[1] ?? "", name: start[2] ?? "", line, tenant: tenantNext };
      tenantNext = false;
      return;
    }
    tenantNext = false;
    if (!open) return;
    if (code.startsWith("}")) {
      if (open.kind === "model") {
        models.push({
          name: open.name,
          line: open.line,
          tenant: open.tenant,
          fields,
          blockAttributes,
        });
      } else if (open.kind === "enum") {
        enums.push(open.name);
      }
      open = undefined;
      fields = [];
      blockAttributes = [];
      return;
    }
    if (open.kind !== "model") return;
    if (code.startsWith("@@")) {
      blockAttributes.push(code);
      return;
    }
    const field = /^(\w+)\s+(\w+(?:\([^)]*\))?)(\[\])?(\?)?\s*(.*)$/.exec(code);
    if (field) {
      fields.push({
        name: field[1] ?? "",
        type: field[2] ?? "",
        list: field[3] !== undefined,
        optional: field[4] !== undefined,
        attributes: field[5] ?? "",
        line,
      });
    }
  });
  return { path, models, enums };
}

/** The findings on one parsed file; `models` are the names declared across the whole folder. */
export function lintSchemaFile(file: SchemaFile, models: ReadonlySet<string>): SchemaFinding[] {
  const findings: SchemaFinding[] = [];
  const found = (line: number, rule: string, message: string) =>
    findings.push({ path: file.path, line, rule, message });
  for (const model of file.models) {
    const map = model.blockAttributes
      .map((attribute) => /^@@map\(\s*"([^"]*)"\s*\)/.exec(attribute)?.[1])
      .find((name) => name !== undefined);
    if (map === undefined) {
      found(model.line, "table-map", `model ${model.name} needs @@map("<snake_case table>")`);
    } else if (!SNAKE.test(map)) {
      found(
        model.line,
        "table-map",
        `model ${model.name} maps to "${map}", not a snake_case table`,
      );
    }
    const ownVendor = VENDORS.find((vendor) => map?.startsWith(`${vendor}_`));
    for (const field of model.fields) {
      if (models.has(field.type)) continue;
      const column = /@map\(\s*"([^"]*)"\s*\)/.exec(field.attributes)?.[1];
      if (column === undefined ? !SNAKE.test(field.name) : !SNAKE.test(column)) {
        found(
          field.line,
          "column-map",
          `${model.name}.${field.name} needs @map("<snake_case column>")`,
        );
      }
      const vendor = VENDOR_ID.exec(column ?? snakeCase(field.name))?.[1];
      if (vendor !== undefined && vendor !== ownVendor) {
        found(
          field.line,
          "provider-refs",
          `${model.name}.${field.name} is a ${vendor} id: vendor ids live in provider_refs (jsonb) keyed by adapter name, or in the adapter's own table`,
        );
      }
      if (
        field.type === "DateTime" &&
        !/@db\.Timestamptz(?:\(\d*\))?(?:\s|$)/.test(field.attributes)
      ) {
        found(
          field.line,
          "timestamptz",
          `${model.name}.${field.name} is a DateTime without @db.Timestamptz: instants are timestamptz in UTC`,
        );
      }
      if (/(?:^|\s)@id(?:\s|$)/.test(field.attributes)) {
        if (field.type !== "String" || /@default\(/.test(field.attributes)) {
          found(
            field.line,
            "id-string-no-default",
            `${model.name}.${field.name} is an @id: a String with no @default, the platform generates <prefix>_<ULID> ids`,
          );
        }
      }
    }
  }
  return findings;
}

/** Every *.prisma file of a folder and its subfolders, which Prisma loads too, sorted. */
export function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".prisma"))
    .sort()
    .map((name) => join(dir, name));
}

/** Every *.prisma file of a folder parsed and linted, the models known across files. */
export function lintSchemaFolder(dir: string): SchemaFinding[] {
  const files = schemaFiles(dir).map((path) => parseSchema(path, readFileSync(path, "utf8")));
  const models = new Set(files.flatMap((file) => file.models.map((model) => model.name)));
  return files.flatMap((file) => lintSchemaFile(file, models));
}

/** `path:line rule message`, the shape of the structural lint's findings. */
export function formatSchemaFinding(finding: SchemaFinding): string {
  return `${finding.path}:${finding.line} ${finding.rule} ${finding.message}`;
}
