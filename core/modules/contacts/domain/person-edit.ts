// A member's edit of a person's profile fields on the lead page (README.md "Routes", PATCH
// …/contacts/leads/{personId}; lead-fields-edit), inside the request's tenant run like every command
// of contacts (persons.ts). A field the edit changes takes the member's value, or none for an empty
// one, with the `member` stamp, which no later source overwrites (provenance.ts); a field it leaves
// out, or sends as it is, keeps its value and provenance; locationCountry follows locationText.
// Nothing else changes: the lead's decision, its statuses and any draft stay as they are, and no
// model is called; the lead page's Re-score is how a member asks for a new judgement.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant } from "@whytide/platform";
import { errors } from "../errors.ts";
import { EDITABLE_FIELDS, type EditableField } from "./constants.ts";
import { countryOf } from "./countries.ts";
import type { Person } from "./persons.ts";
import { MEMBER, type Provenance, type ProvenanceMap } from "./provenance.ts";
import { editPersonInput, parseInput, requireId } from "./rules.ts";

/** What a member sends: any of the six fields, an empty one to clear it (rules.ts). */
export type PersonEdit = Partial<Record<EditableField, string>>;
/** The person's fields an edit reads: the six and their provenance. */
type Stored = Pick<Person, EditableField> & { readonly fieldProvenance: ProvenanceMap };
/** The columns an edit writes. */
type Columns = Partial<Record<EditableField | "locationCountry", string | null>> & {
  fieldProvenance: Record<string, Provenance>;
};

/**
 * The columns a member's `edit`, made `at`, writes on the stored person, the provenance whole; null
 * when it changes no value. A cleared field keeps the member's stamp too, so that no source fills
 * it again.
 */
export function memberEdit(stored: Stored, edit: PersonEdit, at: Date): Columns | null {
  const stamp: Provenance = { source: MEMBER, provider: null, at: at.toISOString() };
  const values: Omit<Columns, "fieldProvenance"> = {};
  const provenance: Record<string, Provenance> = { ...stored.fieldProvenance };
  for (const field of EDITABLE_FIELDS) {
    const given = edit[field];
    if (given === undefined) continue;
    const value = given === "" ? null : given;
    if (value === stored[field]) continue;
    values[field] = value;
    provenance[field] = stamp;
  }
  if (Object.keys(values).length === 0) return null;
  if ("locationText" in values) {
    // The country follows the location it is read from, with the location's provenance.
    const country = values.locationText ? countryOf(values.locationText) : null;
    values.locationCountry = country;
    if (country === null) delete provenance.locationCountry;
    else provenance.locationCountry = stamp;
  }
  return { ...values, fieldProvenance: provenance };
}

/**
 * Applies a member's edit to the person of the workspace's lead `personId`, the person's row locked
 * meanwhile, so that two edits queue and neither loses the other's stamps. lead_not_found for an
 * unknown person, another workspace's or one without a lead; contacts_input_invalid naming the
 * fields off the rules (rules.ts), never a value.
 */
export async function editLeadPerson(personId: string, input: PersonEdit): Promise<void> {
  const id = requireId("personId", personId);
  const edit = parseInput(editPersonInput, input);
  const stored = await lockedLeadPerson(id);
  const data = memberEdit(stored, edit, new Date());
  if (data !== null) await tenantClient.person.update({ where: { id }, data });
}

/** The lead's person, its row locked until the run ends; lead_not_found without a lead. */
async function lockedLeadPerson(id: string): Promise<Stored> {
  const { workspaceId } = currentTenant();
  const [row] = await tenantClient.$queryRaw<Stored[]>`
    SELECT p.first_name AS "firstName", p.last_name AS "lastName", p.headline, p.title,
      p.company_name AS "companyName", p.location_text AS "locationText",
      p.field_provenance AS "fieldProvenance"
    FROM persons p
    JOIN leads l ON l.workspace_id = p.workspace_id AND l.person_id = p.id
    WHERE p.workspace_id = ${workspaceId} AND p.id = ${id}
    FOR UPDATE OF p`;
  if (row === undefined) throw new AppError(errors.lead_not_found);
  return row;
}
