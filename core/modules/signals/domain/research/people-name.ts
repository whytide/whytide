// A picked person no page keyed and no search gave a profile is only a name (README.md "Web research";
// gamma-wr-080). The key's order is the page's, then the profile one search found (people-profile.ts),
// then this: enrichment looks for a work address at the company's domain from the name
// (`workAddressOfName`), and on a verifier's `valid` calls `make` in a tenant run of its own, which
// makes the person with that address as the key, as people-make.ts makes any, with no email lookup
// asked (the lead has its address), publishes the event and counts the person. With no valid address
// nothing of the person is kept anywhere: it goes on to the step's own run as a person with no key. The
// name is asked of enrichment and of nothing else: it is in no count, log line, span, history or file,
// and the credit's key is the found company's id and the person's place in the pick. A person the
// workspace holds at the company already is not asked for, and ENRICHMENT_LOOKUP_AT_FIND off asks
// none. A person made here is made once: a step run again finds them held.
import { outboxWriter, tenantClient } from "@whytide/db";
import { workAddressOfName } from "@whytide/enrichment";
import { publish } from "@whytide/platform";
import { events } from "../../events.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef } from "../runs.ts";
import { COUNT_PEOPLE_ADDRESSES, COUNT_PEOPLE_FOUND } from "./constants.ts";
import { lookupAtFind } from "./lookup-at-find.ts";
import { type MakeContext, makePerson, type PickedPerson } from "./people-make.ts";

/** A name as contacts splits it: the first word, then the rest (contacts' splitName). */
export function splitPersonName(name: string): { firstName: string; lastName: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { firstName: first ?? "", lastName: rest.join(" ") };
}

/**
 * The people made through a work address looked up for their name, by their place in `people`
 * (from 0): their ids. `unknown`: the names the workspace holds no person of at the company; only
 * those with no profile and no address of the page are asked for. In the pick's order, one at a
 * time, outside any run of the step's own: enrichment opens its tenant runs.
 */
export async function addressesByName(input: {
  readonly ref: RunRef;
  readonly foundCompanyId: string;
  readonly domain: string;
  readonly people: readonly PickedPerson[];
  readonly unknown: ReadonlySet<string>;
  readonly context: MakeContext;
  readonly tenant: TenantRun;
}): Promise<Map<number, string>> {
  const { ref, foundCompanyId, domain, people, unknown, context, tenant } = input;
  const made = new Map<number, string>();
  if (!lookupAtFind()) return made;
  const { workspaceId, runId } = ref;
  for (const [index, person] of people.entries()) {
    if (person.profile !== null || person.email !== null || !unknown.has(person.name)) continue;
    const key = `${foundCompanyId}:${index + 1}`;
    const make = (address: string) => makeWith(address, person);
    const result = await workAddressOfName(
      { ...splitPersonName(person.name), domain, key },
      { workspaceId, tenant, make },
    );
    if (result.status === "found") made.set(index, result.personId);
  }
  return made;

  /** In enrichment's tenant run: the person, the event and the counts, or none. */
  async function makeWith(address: string, picked: PickedPerson): Promise<string | null> {
    const outcome = await makePerson(context, { ...picked, email: address }, { lookup: false });
    if (outcome.outcome !== "found") return null;
    const outbox = outboxWriter(tenantClient, workspaceId);
    await publish(outbox, events["signals.person_found"], {
      workspaceId,
      personIds: [outcome.personId],
    });
    await addCounts(runId, { [COUNT_PEOPLE_FOUND]: 1, [COUNT_PEOPLE_ADDRESSES]: 1 });
    return outcome.personId;
  }
}
