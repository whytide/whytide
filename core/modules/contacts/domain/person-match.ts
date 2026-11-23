// The match of a company's persons by name (README.md "Public interface"; gamma-wr-060), inside the
// caller's tenant run like every command of contacts (persons.ts): a research run takes the people a
// page names, and before it makes a person it asks whether the workspace holds that human at that
// company already (RB-17.1.2: one human, one person). Contacts keeps its two keys, a profile and an
// address: this read makes nobody and finds a person by name alone only inside one company.
import { tenantClient } from "@whytide/db";
import { COMPANY_PERSONS_MATCHED_MAX } from "./constants.ts";
import { matchByNameInput, parseInput } from "./rules.ts";

/** A name as it is compared: compatibility forms, accents and case folded, punctuation as a space. */
export function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The ids of the workspace's persons at the company whose name is `name`, in id order: the persons with
 * the company's id, and those whose company name is the same, case aside, whatever company they are
 * linked to (a person a LinkedIn import linked to the company's page is the one a site names). A person's name is their first and last name together,
 * and a match is of the whole name, accents, case, punctuation and spacing aside; a name of one word
 * matches a person with only that word. A company given by neither an id nor a name, or a blank name, is
 * `contacts_input_invalid`.
 */
export async function findPersonsByNameAtCompany(input: {
  name: string;
  companyId?: string | null;
  companyName?: string | null;
}): Promise<string[]> {
  const { name, companyId, companyName } = parseInput(matchByNameInput, input);
  const wanted = nameKey(name);
  if (wanted === "") return [];
  const at = [
    ...(companyId == null ? [] : [{ companyId }]),
    ...(companyName == null
      ? []
      : [{ companyName: { equals: companyName, mode: "insensitive" as const } }]),
  ];
  const rows = await tenantClient.person.findMany({
    where: { OR: at },
    select: { id: true, firstName: true, lastName: true },
    orderBy: { id: "asc" },
    take: COMPANY_PERSONS_MATCHED_MAX,
  });
  return rows
    .filter((row) => nameKey(`${row.firstName ?? ""} ${row.lastName ?? ""}`) === wanted)
    .map(({ id }) => id);
}
