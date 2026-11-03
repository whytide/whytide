// What registration learns from a payload schema, read from the JSON Schema Zod exports for its output
// (a public API: no walk of Zod's internals): the field names at any depth, for the PII check in
// index.ts, and whether the schema can carry a payload at all. A payload is a closed object of ids and
// counts. A value JSON cannot carry (a Date, a BigInt, a Map, a custom type) or a transform, which
// would run at publish and again at delivery, is unrepresentable; a record, a catch-all or a loose
// object admits keys nobody declared; z.any() and z.unknown() admit anything. All of them fail.
import { z } from "zod";

export type SchemaProblem = "not_an_object" | "unrepresentable" | "open_fields" | "anything";
export type EventSchemaAnalysis = {
  /** Every property name declared at any depth, each once, in order of first appearance. */
  readonly fields: readonly string[];
  readonly problem?: SchemaProblem;
};

type JsonSchema = Record<string, unknown>;
const MAPS = ["properties", "$defs", "definitions"];
const LISTS = ["prefixItems", "anyOf", "oneOf", "allOf"];
const NESTED = ["items", "not"];
/** A node with none of these constrains nothing: `{}` is what z.any() exports. */
const CONSTRAINTS = ["type", "enum", "const", "anyOf", "oneOf", "allOf", "not", "$ref"];

export function analyzeEventSchema(schema: z.ZodType): EventSchemaAnalysis {
  let root: JsonSchema;
  try {
    root = z.toJSONSchema(schema, { io: "output", unrepresentable: "throw" }) as JsonSchema;
  } catch {
    return { fields: [], problem: "unrepresentable" };
  }
  if (root.type !== "object") return { fields: [], problem: "not_an_object" };
  const fields = new Set<string>();
  let problem: SchemaProblem | undefined;
  const visit = (node: unknown): void => {
    if (problem || !isObject(node)) return;
    if (!CONSTRAINTS.some((key) => key in node)) {
      problem = "anything";
      return;
    }
    if (isObject(node.additionalProperties) || node.patternProperties !== undefined) {
      problem = "open_fields";
      return;
    }
    if (isObject(node.properties))
      for (const name of Object.keys(node.properties)) fields.add(name);
    for (const key of MAPS) {
      const map = node[key];
      if (isObject(map)) Object.values(map).forEach(visit);
    }
    for (const key of LISTS) {
      const list = node[key];
      if (Array.isArray(list)) list.forEach(visit);
    }
    for (const key of NESTED) visit(node[key]);
  };
  visit(root);
  return { fields: [...fields], problem };
}

function isObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
