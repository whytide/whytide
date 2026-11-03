// The dossier's shape (schemas/dossier.ts, README.md "The dossier"): strict objects at every depth
// whose fields are the listed ones, so no email, phone, photo, contact detail or field a visibility
// setting hides can be present, in the schema or in a dossier it accepts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { assembleDossier } from "../domain/dossier/assemble.ts";
import { dossierSchema } from "../schemas/dossier.ts";
import { inputs } from "./fixtures/dossier/inputs.ts";

type JsonSchema = {
  type?: string;
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: unknown;
};

/** Every field's path (`whyNow[].postUrl`), each object checked closed on the way. */
function fieldsOf(schema: JsonSchema, path = ""): string[] {
  if (schema.anyOf) return schema.anyOf.flatMap((member) => fieldsOf(member, path));
  if (schema.type === "array" && schema.items) return fieldsOf(schema.items, `${path}[]`);
  if (schema.type !== "object") return [];
  assert.equal(schema.additionalProperties, false, `${path || "the dossier"} is a strict object`);
  return Object.entries(schema.properties ?? {}).flatMap(([key, field]) => {
    const at = path === "" ? key : `${path}.${key}`;
    return [at, ...fieldsOf(field, at)];
  });
}

test("the dossier holds the listed fields only, every object strict: no email, phone, photo, contact detail or hidden field can be present", () => {
  const fields = fieldsOf(z.toJSONSchema(dossierSchema) as JsonSchema);
  assert.deepEqual(fields, [
    ...["sender", "sender.name"],
    ...["offer", "offer.oneLiner", "offer.products", "offer.painPoints", "offer.proofPoints"],
    ...["lead", "lead.firstName", "lead.headline", "lead.title", "lead.location"],
    ...["company", "company.name", "company.industry", "company.sizeRange", "company.country"],
    "whyNow",
    ...["whyNow[].postUrl", "whyNow[].excerpt", "whyNow[].comment", "whyNow[].reaction"],
    "whyNow[].at",
    ...["facts", "facts[].id", "facts[].kind", "facts[].value", "facts[].sourceRef"],
    ...["entities", "entities[].kind", "entities[].value", "entities[].factIds"],
    "dossierHash",
  ]);
  for (const field of fields) {
    assert.doesNotMatch(field, /mail|phone|photo|picture|avatar|image|contact|birth|address/i);
  }

  const dossier = assembleDossier(inputs);
  const added = (block: "sender" | "lead" | "company", field: string) => ({
    ...dossier,
    [block]: { ...dossier[block], [field]: "x" },
  });
  const refused = [
    added("lead", "email"),
    added("lead", "phone"),
    added("lead", "photoUrl"),
    added("lead", "lastName"),
    added("lead", "birthday"),
    added("company", "contactInfo"),
    added("sender", "email"),
    { ...dossier, email: "ines@example.com" },
    { ...dossier, whyNow: dossier.whyNow.map((item) => ({ ...item, author: "Ines Duarte" })) },
  ];
  for (const candidate of refused) assert.throws(() => dossierSchema.parse(candidate), z.ZodError);
  assert.deepEqual(dossierSchema.parse(dossier), dossier);
});
