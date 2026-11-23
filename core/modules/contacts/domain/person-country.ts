// A source's country for a person (README.md "Public interface", gamma-en-040), inside the caller's
// tenant run like every command of contacts (persons.ts): what enrichment learns of a person's
// country, merged with provenance as upsertPersonFromSource merges a source's values (provenance.ts):
// a value read later wins, and a member's stays. Only location_country is written; the location's
// text and its provenance stay as they are.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant } from "@whytide/platform";
import { errors } from "../errors.ts";
import { getPerson, type Person } from "./persons.ts";
import { mergeFields, type Provenance, type Source } from "./provenance.ts";
import { parseInput, recordCountryInput } from "./rules.ts";

/** Who gives the country: the source's class, its provider's name, and when it read the value. */
export type CountryStamp = { source: Source; provider: Provenance["provider"]; at?: Date };

/**
 * Writes `country`, one of icp's COUNTRIES as its code, as the person's location_country with the
 * source's stamp (`at` now when absent), unless the stored country was read later or a member's
 * edit set it. The person's row is locked meanwhile, so that a member's edit under way is waited for
 * and kept. The person as the call leaves it, and whether the country was written.
 * contacts_input_invalid naming the fields off the rules, a country off the list among them;
 * person_not_found.
 */
export async function recordPersonCountry(input: {
  personId: string;
  country: string;
  stamp: CountryStamp;
}): Promise<{ person: Person; written: boolean }> {
  const { personId, country, stamp } = parseInput(recordCountryInput, input);
  await lockPerson(personId);
  const stored = await getPerson(personId);
  const at = (stamp.at ?? new Date()).toISOString();
  const merged = mergeFields(
    stored.fieldProvenance,
    { locationCountry: country },
    { source: stamp.source, provider: stamp.provider, at },
  );
  if (!("locationCountry" in merged.values)) return { person: stored, written: false };
  const person = await tenantClient.person.update({
    where: { id: personId },
    data: { locationCountry: country, fieldProvenance: merged.provenance },
  });
  return { person: person as Person, written: true };
}

/** Locks the person's row until the run ends; person_not_found for none of the workspace's. */
async function lockPerson(id: string): Promise<void> {
  const { workspaceId } = currentTenant();
  const rows = await tenantClient.$queryRaw<{ id: string }[]>`
    SELECT id FROM persons WHERE workspace_id = ${workspaceId} AND id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new AppError(errors.person_not_found);
}
