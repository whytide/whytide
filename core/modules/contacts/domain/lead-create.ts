// A member's lead added by hand on the Leads screen (README.md "Routes", POST …/contacts/leads;
// lead-manual-create), inside the request's tenant run like every command of contacts (persons.ts):
// the person of a LinkedIn profile URL with the profile fields the member typed, then the person's
// one lead from the `manual` source, `{ kind: manual, ref: <the member's user id>, at }`. Each
// value the member gave takes the `member` stamp, which no later LinkedIn, import or website value
// overwrites (provenance.ts); a field left empty takes none, so that a source may fill it later. No
// model is called and no event published: the lead is pending and held for enrichment (hold.ts), as
// an import's is, and qualification's batch scores it on a tick once its hold ends.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import type { EditableField } from "./constants.ts";
import { hashOf } from "./hash.ts";
import { anyErased } from "./hashes.ts";
import { createLeadForPerson } from "./leads.ts";
import { normalizeLinkedinUrl } from "./linkedin-url.ts";
import { memberEdit, type PersonEdit } from "./person-edit.ts";
import type { Person } from "./persons.ts";
import { MEMBER, type Provenance } from "./provenance.ts";
import { memberLeadInput, parseInput } from "./rules.ts";

/**
 * What a member sends: the profile URL and the six fields, as the route's body names them; the
 * first name is required by the rules (rules.ts), so that its absence is refused on its field.
 */
export type MemberLead = { linkedinUrl: string } & PersonEdit;
/** A stored person as the command reads it: its id, the six fields and their provenance. */
type Stored = Pick<Person, "id" | EditableField | "fieldProvenance">;

/** A person not stored yet: no value and no provenance, which a member's edit fills. */
const NO_PERSON: Omit<Stored, "id"> = {
  firstName: null,
  lastName: null,
  headline: null,
  title: null,
  companyName: null,
  locationText: null,
  fieldProvenance: {},
};

/**
 * The person of the URL with the member's values and their new lead from the member: the person's
 * id. linkedin_url_invalid for a URL that is no profile; contacts_input_invalid naming the fields
 * off the rules (rules.ts), never a value; person_erased when the URL has an erased person's hash;
 * lead_exists, with `details.personId`, when the person has a lead already; each refusal writes
 * nothing. A person stored without a lead takes the member's values as an edit (person-edit.ts),
 * its row locked meanwhile, so that two adds of one URL queue and the second meets the first one's
 * lead.
 */
export async function createLeadByMember(input: MemberLead): Promise<string> {
  const { linkedinUrl: url, ...typed } = parseInput(memberLeadInput, input);
  const linkedinUrl = normalizeLinkedinUrl(url);
  if (linkedinUrl === null) throw new AppError(errors.linkedin_url_invalid);
  // The lock first: an erasure under way is waited for, and its hash is then read as committed.
  const stored = await lockedPerson(linkedinUrl);
  if (await anyErased([hashOf("url", linkedinUrl)])) throw new AppError(errors.person_erased);
  const given = filled(typed);
  const at = new Date();
  if (stored !== null) {
    await refuseLeadOf(stored.id);
    const data = memberEdit(stored, given, at);
    if (data !== null) await tenantClient.person.update({ where: { id: stored.id }, data });
  }
  const personId = stored?.id ?? (await createPerson(linkedinUrl, given, at));
  const ref = currentTenant().principal.userId;
  const { created } = await createLeadForPerson({ personId, source: { kind: "manual", ref, at } });
  // A lead another run gave the person meanwhile, an import's, which takes no lock on the person:
  // refused as well, and the run rolls back what this one wrote.
  if (!created) throw new AppError(errors.lead_exists, { details: { personId } });
  return personId;
}

/** The fields the member filled in: an empty optional one is none, so it takes no stamp. */
function filled(typed: PersonEdit): PersonEdit {
  const entries = Object.entries(typed).filter(([, value]) => value !== undefined && value !== "");
  return Object.fromEntries(entries) as PersonEdit;
}

/** lead_exists, naming the person, when the workspace has the person's lead. */
async function refuseLeadOf(personId: string): Promise<void> {
  const lead = await tenantClient.lead.findFirst({
    where: { personId },
    select: { personId: true },
  });
  if (lead !== null) throw new AppError(errors.lead_exists, { details: { personId } });
}

/** A new person of the URL with the member's values, each stamped `member`, the URL too: its id. */
async function createPerson(linkedinUrl: string, given: PersonEdit, at: Date): Promise<string> {
  // The first name is always given, so the edit of a person with no value changes something.
  const columns = memberEdit(NO_PERSON, given, at) ?? { fieldProvenance: {} };
  const stamp: Provenance = { source: MEMBER, provider: null, at: at.toISOString() };
  const fieldProvenance = { ...columns.fieldProvenance, linkedinUrl: stamp };
  const id = newId(ids.person);
  const { workspaceId } = currentTenant();
  await tenantClient.person.create({
    data: { ...columns, fieldProvenance, id, workspaceId, linkedinUrl },
  });
  return id;
}

/** The workspace's person with the URL, its row locked until the run ends; null for none. */
async function lockedPerson(linkedinUrl: string): Promise<Stored | null> {
  const { workspaceId } = currentTenant();
  const [row] = await tenantClient.$queryRaw<Stored[]>`
    SELECT id, first_name AS "firstName", last_name AS "lastName", headline, title,
      company_name AS "companyName", location_text AS "locationText",
      field_provenance AS "fieldProvenance"
    FROM persons
    WHERE workspace_id = ${workspaceId} AND linkedin_url = ${linkedinUrl}
    FOR UPDATE`;
  return row ?? null;
}
