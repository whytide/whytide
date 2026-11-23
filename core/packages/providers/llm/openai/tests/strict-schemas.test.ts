// The seven registered agent tasks' output schemas through the adapter (README.md "Tests"), run by
// `pnpm -F providers test:contract`: each call, made against the local stand-in (stand-in.ts),
// sends its schema as json_schema with strict on, and the schema as sent meets OpenAI's strict
// mode: the keywords and formats it supports alone, every object closed and wholly required, the
// limits. What the subset drops still holds, by zod. The schemas are the modules' own files, loaded
// by path when the test runs: the package itself depends on no module.
import assert from "node:assert/strict";
import { after, it } from "node:test";
import type { JSONSchema7, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { openaiLlm } from "../index.ts";
import { startStandIn } from "./stand-in.ts";

/** Each task, by name: its schema file under core/modules/, the name's export and the schema's. */
const TASKS = {
  "icp.draft-profile": ["icp/schemas/draft-profile.ts", "DRAFT_PROFILE", "draftProfileOutput"],
  "onboarding.draft-company-knowledge": [
    "onboarding/schemas/draft-company-knowledge.ts",
    "DRAFT_COMPANY_KNOWLEDGE",
    "draftOutput",
  ],
  "messaging.plan-message": ["messaging/schemas/writer.ts", "PLAN_MESSAGE", "planOutput"],
  "messaging.write-message": ["messaging/schemas/writer.ts", "WRITE_MESSAGE", "writeOutput"],
  "messaging.write-email": ["messaging/schemas/writer.ts", "WRITE_EMAIL", "writeEmailOutput"],
  "qualification.assess-fit": [
    "qualification/schemas/assess-fit.ts",
    "ASSESS_FIT",
    "assessFitOutput",
  ],
  "signals.rate-engagement": [
    "signals/schemas/rate-engagement.ts",
    "RATE_ENGAGEMENT",
    "rateEngagementOutput",
  ],
} as const;

// OpenAI's Structured Outputs guide, "Supported schemas", read 2026-11-02: the keywords it supports
// (`definitions` being draft-07's `$defs`), the formats, and the limits. Listed here again, apart
// from the adapter's own list, so that the test checks the guide, not the code.
const KEYWORDS = new Set([
  ...["type", "properties", "required", "additionalProperties", "items", "anyOf", "enum", "const"],
  ...["description", "$ref", "$defs", "definitions"],
  ...["pattern", "format"],
  ...["multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum"],
  ...["minItems", "maxItems"],
]);
const FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);
const LIMITS = { properties: 5000, depth: 10, enumValues: 1000, characters: 120_000 };
/** A string enum of more than 250 values holds 15,000 characters at most. */
const LARGE_ENUM = { values: 250, characters: 15_000 };

type Schema = Readonly<Record<string, unknown>> & {
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly items?: Schema;
  readonly anyOf?: readonly Schema[];
  readonly enum?: readonly unknown[];
  readonly $defs?: Readonly<Record<string, Schema>>;
  readonly definitions?: Readonly<Record<string, Schema>>;
};

/** What OpenAI's strict mode refuses in a schema, one line each; none when it passes. */
function strictProblems(root: Schema): string[] {
  const problems: string[] = [];
  const totals = { properties: 0, enumValues: 0, characters: 0 };
  if (root.type !== "object" || root.anyOf) problems.push("the root is not a plain object");
  const visit = (schema: Schema, path: string, depth: number) => {
    for (const key of Object.keys(schema)) {
      if (!KEYWORDS.has(key)) problems.push(`${path || "/"}: ${key} is not supported`);
    }
    if (!["type", "anyOf", "$ref", "enum", "const"].some((key) => key in schema)) {
      problems.push(`${path || "/"}: no type`);
    }
    if (typeof schema.format === "string" && !FORMATS.has(schema.format)) {
      problems.push(`${path}: the format ${schema.format} is not supported`);
    }
    if (schema.properties !== undefined || schema.type === "object") {
      if (depth > LIMITS.depth) problems.push(`${path}: nested deeper than ${LIMITS.depth}`);
      if (schema.additionalProperties !== false) {
        problems.push(`${path || "/"}: additionalProperties is not false`);
      }
      const keys = Object.keys(schema.properties ?? {});
      totals.properties += keys.length;
      totals.characters += keys.join("").length;
      const optional = keys.filter((key) => !schema.required?.includes(key));
      if (optional.length > 0) problems.push(`${path || "/"}: not required: ${optional}`);
      for (const key of keys) visit(schema.properties?.[key] ?? {}, `${path}/${key}`, depth + 1);
    }
    if (schema.items !== undefined) visit(schema.items, `${path}[]`, depth + 1);
    for (const [at, option] of (schema.anyOf ?? []).entries())
      visit(option, `${path}|${at}`, depth);
    for (const [name, definition] of Object.entries({ ...schema.$defs, ...schema.definitions })) {
      totals.characters += name.length;
      visit(definition, `#${name}`, 1);
    }
    if (schema.enum !== undefined) {
      const characters = schema.enum.map(String).join("").length;
      totals.enumValues += schema.enum.length;
      totals.characters += characters;
      if (schema.enum.length > LARGE_ENUM.values && characters > LARGE_ENUM.characters) {
        problems.push(`${path}: an enum of ${schema.enum.length} values, ${characters} characters`);
      }
    }
    if (schema.const !== undefined) totals.characters += String(schema.const).length;
  };
  visit(root, "", 1);
  if (totals.properties > LIMITS.properties) problems.push(`${totals.properties} properties`);
  if (totals.enumValues > LIMITS.enumValues) problems.push(`${totals.enumValues} enum values`);
  if (totals.characters > LIMITS.characters) problems.push(`${totals.characters} characters`);
  return problems;
}

const standIn = await startStandIn();
after(() => standIn.close());
const { model } = await openaiLlm({ apiKey: "made-up", baseURL: standIn.baseURL }).getModel({
  modelRef: "gpt-6.1-sol",
  onUsage: () => {},
});
/** The response format of the last request the stand-in received. */
const sentFormat = () =>
  standIn.received.at(-1)?.body.text?.format as
    | { type?: string; strict?: boolean; schema?: Schema }
    | undefined;

it("the checker refuses what strict mode refuses", () => {
  const optional = { type: "object", properties: { a: { type: "string" } }, required: [] };
  assert.deepEqual(strictProblems({ ...optional, additionalProperties: false }), [
    "/: not required: a",
  ]);
  const loose = { type: "object", properties: { a: { allOf: [] } }, required: ["a"] };
  assert.deepEqual(strictProblems(loose), [
    "/: additionalProperties is not false",
    "/a: allOf is not supported",
    "/a: no type",
  ]);
  assert.deepEqual(strictProblems({ anyOf: [] }), ["the root is not a plain object"]);
  const a = { type: "string", minLength: 1, maxLength: 9, format: "uri", default: "x" };
  const sized = { $schema: "x", ...optional, properties: { a }, required: ["a"] };
  assert.deepEqual(strictProblems({ ...sized, additionalProperties: false }), [
    "/: $schema is not supported",
    "/a: minLength is not supported",
    "/a: maxLength is not supported",
    "/a: default is not supported",
    "/a: the format uri is not supported",
  ]);
});

for (const [task, [file, nameExport, schemaExport]] of Object.entries(TASKS)) {
  it(`${task}: its output schema goes out as json_schema, strict, and meets strict mode`, async () => {
    const path = new URL(`../../../../../modules/${file}`, import.meta.url);
    const loaded: Record<string, unknown> = await import(path.href);
    assert.equal(loaded[nameExport], task, "the file names the task");
    const schema = loaded[schemaExport] as z.ZodType;
    // The stand-in answers the contract's object, not this schema's: only the request counts here.
    await generateText({ model, prompt: task, output: Output.object({ schema }) }).catch(() => {});
    const format = sentFormat();
    assert.equal(format?.type, "json_schema");
    assert.equal(format?.strict, true);
    assert.deepEqual(strictProblems(format?.schema ?? {}), []);
  });
}

it("a minLength, a maxLength and a uri format are dropped from the request, and zod still enforces them", async () => {
  const site = z.object({ name: z.string().min(2).max(8), url: z.url() });
  const ask = (answer: object) =>
    generateText({
      model,
      prompt: `json ${JSON.stringify(answer)}`,
      output: Output.object({ schema: site }),
    });
  const fine = { name: "Ada", url: "https://example.com/" };
  assert.deepEqual((await ask(fine)).output, fine);
  assert.deepEqual(sentFormat(), {
    type: "json_schema",
    strict: true,
    name: "response",
    schema: {
      type: "object",
      properties: { name: { type: "string" }, url: { type: "string" } },
      required: ["name", "url"],
      additionalProperties: false,
    },
  });
  for (const wrong of [
    { ...fine, name: "A" },
    { ...fine, name: "Ada Lovelace" },
    { ...fine, url: "example" },
  ]) {
    await assert.rejects(ask(wrong), (error) => NoObjectGeneratedError.isInstance(error));
  }
});

it("the caller's schema is left as it is: the request carries a trimmed copy", async () => {
  const schema: JSONSchema7 = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { name: { type: "string", minLength: 2, title: "Name", default: "Ada" } },
    required: ["name"],
    additionalProperties: false,
  };
  const before = structuredClone(schema);
  const prompt: LanguageModelV4Prompt = [
    { role: "user", content: [{ type: "text", text: "copy" }] },
  ];
  await model.doGenerate({ prompt, responseFormat: { type: "json", schema } });
  assert.deepEqual(schema, before);
  assert.deepEqual(sentFormat()?.schema, {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  });
});
