// A person a found company's pages named, made a lead (README.md "Web research"; gamma-wr-060), in the
// caller's tenant run, one at a time. Contacts first matches the workspace's persons at the company by
// name (RB-17.1.2, one human, one person): one match is that person, more than one skips the name. Else
// a person needs a key the page printed, a LinkedIn profile or an address at the company's own domain,
// or the profile one web search found (people-profile.ts, gamma-wr-070: the evidence says so,
// `found_by`); contacts keeps no person made by a name alone, so with none of them nothing is made or kept. The person
// goes through `upsertPersonFromSource` (the name, the role as the title, the key; one with a profile
// and an address keeps both, the address as its hash only), `linkPersonToCompany` and, for a person
// with no country yet, `recordPersonCountry` with the country the page gives for them, else the
// company's; a `person_conflict` is tried once more, then the name is skipped; an erased person is
// skipped. The lead is made as signals makes one, source kind `signal`, the source's id and label and the
// page's address; then the event, of the kind's own name, and its evidence (the page and no name):
// one event for each source and person. The event is never rated: it carries a found company, which the
// rating does not pick. A new lead is asked one email lookup, with the trigger `found`, in the same run
// (gamma-wr-070, enrichment's requestLookup): the address a page printed with the person goes with it
// and is held by enrichment's request only while the lookup runs; ENRICHMENT_LOOKUP_AT_FIND off, none
// is asked. A phone the page printed with the person is kept for them by enrichment's keepPhone, with
// the page's address (gamma-wr-100), never as a key. No name, role, link, address or number reaches a
// log, a span, a metric or the history.
import {
  errors as contactsErrors,
  createLeadForPerson,
  findPersonsByNameAtCompany,
  linkPersonToCompany,
  recordPersonCountry,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import {
  errors as enrichmentErrors,
  keepPhone,
  type PhoneOutcome,
  requestLookup,
} from "@whytide/enrichment";
import { isAppError, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { dedupeKeyOf } from "../process/rules.ts";
import {
  FOUND_BY_MANAGERS,
  FOUND_BY_SEARCH,
  MANAGERS_EVIDENCE_TITLE_CHARS,
  PEOPLE_EVENT_ROLE,
  PEOPLE_LOOKUP_KEY,
  PEOPLE_STAMP,
} from "./constants.ts";
import { lookupAtFind } from "./lookup-at-find.ts";
import type { GatedPerson } from "./people-checks.ts";
import { fit } from "./text.ts";

/**
 * How one person ended: made a new lead (`lookup`: whether an email lookup was asked for it),
 * attached to a person the workspace holds, or not made. A person made or attached also says how
 * their phone ended, when the page printed one (gamma-wr-100).
 */
export type PersonOutcome =
  | {
      readonly outcome: "found";
      readonly personId: string;
      readonly lookup: boolean;
      readonly phone?: PhoneOutcome["outcome"];
    }
  | {
      readonly outcome: "known";
      readonly personId: string;
      readonly phone?: PhoneOutcome["outcome"];
    }
  | { readonly outcome: "no_key" | "ambiguous" | "conflict" | "erased" };

/**
 * A picked person; `bySearch`: their profile was found by search, not printed (gamma-wr-070);
 * `managers`: they were found by the search of the company's managers (gamma-wr-090), with the title
 * of the result that gave them and the company's site as the address of their evidence.
 */
export type PickedPerson = GatedPerson & {
  readonly bySearch?: true;
  readonly managers?: { readonly title: string; readonly address: string };
};

/** What a person is made with: the run, the source, the company, and the pages' addresses. */
export type MakeContext = {
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly runId: string;
  readonly sourceLabel: string;
  /** The source's event kind: `web_research`. */
  readonly eventKind: string;
  readonly company: {
    readonly foundCompanyId: string;
    readonly name: string;
    /** Contacts' company of the workspace; null when contacts took none. */
    readonly companyId: string | null;
    readonly country: string | null;
  };
  /** The address of each page the people were read from, by its number. */
  readonly pages: ReadonlyMap<number, string>;
  readonly now: Date;
};

/** The lead's source url must be https, 2,048 characters at most (contacts' rule); else none. */
const leadUrlOf = (address: string): { url: string } | Record<string, never> =>
  address.startsWith("https://") && address.length <= 2048 ? { url: address } : {};

/**
 * `lookup: false`: no email lookup is asked for the new lead, as for one made with a verified address
 * (gamma-wr-080: people-name.ts), which it has already.
 */
export async function makePerson(
  context: MakeContext,
  person: PickedPerson,
  options: { readonly lookup?: boolean } = {},
): Promise<PersonOutcome> {
  const { company } = context;
  const matches = await findPersonsByNameAtCompany({
    ...{ name: person.name, companyName: company.name },
    ...(company.companyId === null ? {} : { companyId: company.companyId }),
  });
  if (matches.length > 1) return { outcome: "ambiguous" };
  const held = matches[0];
  let personId = held;
  if (personId === undefined) {
    if (person.profile === null && person.email === null) return { outcome: "no_key" };
    const made = await upsertOnce(context, person);
    if (typeof made !== "string") return made;
    personId = made;
  }
  const address = person.managers?.address ?? context.pages.get(person.page) ?? "";
  const source = {
    ...{ kind: "signal" as const, ref: context.sourceId, at: context.now },
    ...{ label: context.sourceLabel, ...leadUrlOf(address) },
  };
  const { created } = await createLeadForPerson({ personId, source });
  await writeEvent(context, personId, address, markOf(person));
  // The number the page printed with them, kept for them with that page; never a key of the person.
  const phone =
    person.phone === null
      ? undefined
      : (await keepPhone(personId, { number: person.phone, page: address }, context.now)).outcome;
  const phoned = phone === undefined ? {} : { phone };
  if (!created) return { outcome: "known", personId, ...phoned };
  const lookup = options.lookup !== false && (await askLookup(personId, person.email));
  return { outcome: "found", personId, lookup, ...phoned };
}

/**
 * The email lookup of a new lead, with the address a page printed with them; whether one was asked.
 * An address the lookup refuses as no address is left out and the lookup asked without it.
 */
async function askLookup(personId: string, address: string | null): Promise<boolean> {
  if (!lookupAtFind()) return false;
  const asking = {
    personId,
    requestKey: `${PEOPLE_LOOKUP_KEY}:${personId}`,
    trigger: "found",
  } as const;
  try {
    await requestLookup(address === null ? asking : { ...asking, address });
  } catch (error) {
    const invalid = isAppError(error) && error.code === enrichmentErrors.enrichment_input_invalid;
    if (!invalid || address === null) throw error;
    await requestLookup(asking);
  }
  return true;
}

/** The person upserted, a conflict tried once more; the person's id, or why none. */
async function upsertOnce(
  context: MakeContext,
  person: GatedPerson,
): Promise<string | { outcome: "conflict" | "erased" }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await upsert(context, person);
    } catch (error) {
      if (!isAppError(error)) throw error;
      if (error.code === contactsErrors.person_erased) return { outcome: "erased" };
      if (error.code !== contactsErrors.person_conflict) throw error;
    }
  }
  return { outcome: "conflict" };
}

/** The person, its company and, with none yet, its country. */
async function upsert(context: MakeContext, person: GatedPerson): Promise<string> {
  const { company, now } = context;
  const keys = {
    ...(person.profile === null ? {} : { linkedinUrl: person.profile }),
    ...(person.email === null ? {} : { email: person.email }),
  };
  const profile = {
    ...{ name: person.name, title: person.role, companyName: company.name, fetchedAt: now },
    ...keys,
  };
  const { person: stored } = await upsertPersonFromSource({
    ...PEOPLE_STAMP,
    profile: profile as typeof profile & ({ linkedinUrl: string } | { email: string }),
  });
  if (company.companyId !== null) {
    await linkPersonToCompany({ personId: stored.id, companyId: company.companyId });
  }
  const country = person.country ?? company.country;
  if (country !== null && stored.locationCountry === null) {
    try {
      await recordPersonCountry({
        personId: stored.id,
        country,
        stamp: { ...PEOPLE_STAMP, at: now },
      });
    } catch (error) {
      // A code contacts does not list is no country; the person has none.
      if (!isAppError(error) || error.code !== contactsErrors.contacts_input_invalid) throw error;
    }
  }
  return stored.id;
}

/** What the evidence says of how the person was found: the mark and, for a manager found by search, the result's title. */
type EvidenceMark = {
  readonly foundBy: typeof FOUND_BY_SEARCH | typeof FOUND_BY_MANAGERS | null;
  readonly excerpt?: string;
};

function markOf(person: PickedPerson): EvidenceMark {
  if (person.managers !== undefined) {
    const title = fit(person.managers.title, MANAGERS_EVIDENCE_TITLE_CHARS);
    return { foundBy: FOUND_BY_MANAGERS, ...(title === "" ? {} : { excerpt: title }) };
  }
  return { foundBy: person.bySearch === true ? FOUND_BY_SEARCH : null };
}

/** The research event of the person and its evidence, one for each source and person. */
async function writeEvent(
  context: MakeContext,
  personId: string,
  address: string,
  mark: EvidenceMark,
): Promise<void> {
  const { workspaceId, sourceId, runId, eventKind, company, now } = context;
  const id = newId(ids.signal_event);
  const dedupeKey = dedupeKeyOf({
    ...{ kind: eventKind, actor: personId, objectUrl: sourceId, role: PEOPLE_EVENT_ROLE },
  });
  const event = {
    ...{ id, workspaceId, personId, sourceId, runId, kind: eventKind, dedupeKey },
    ...{ occurredAt: now, foundCompanyId: company.foundCompanyId },
  };
  const { count } = await tenantClient.signalEvent.createMany({
    data: [event],
    skipDuplicates: true,
  });
  if (count === 0) return;
  // The page the person was found on, and nothing of them: no name, no words, no reaction.
  await tenantClient.evidence.create({
    data: {
      id: newId(ids.evidence),
      ...{ workspaceId, eventId: id, url: address, reaction: null, author: null },
      ...mark,
      capturedAt: now,
    },
  });
}
