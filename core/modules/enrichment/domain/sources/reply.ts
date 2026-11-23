// The email source `reply` (README "The sources reply, website and pattern"; gamma-en-085): the
// addresses the lead wrote in their own LinkedIn messages, through inbox's addressesGivenBy in a run of
// the lookup's workspace, newest message first. Inbox sets that reader in its onWorkerStart
// (useAddressesGiven): enrichment never imports inbox, which imports campaigns, which imports
// enrichment (docs/rules/coding.md §2). Without a reader the source finds nothing. Role addresses are left out. A message holding one
// address gives it; one holding several gives only those whose local part holds the lead's first or
// family name, cleaned, as the others are likely a colleague's. Any domain (`anyDomain`, the owner's
// decision of 2026-11-13): an address at the company's domain first, then the others, a personal one
// following the UK and EU switch (the find step's). No outside call; only a verifier's valid keeps one.
import { localOf } from "../email/addresses.ts";
import { REPLY, SOURCE_CLASSES } from "../email/constants.ts";
import { type Names, namesOf } from "../email/names.ts";
import { isRoleAddress } from "../email/roles.ts";
import { atDomain } from "../lookup/key.ts";
import { defineSource, type EmailSourceAnswer } from "./define.ts";

/** A name counts in a local part from two letters. */
const NAME_MIN = 2;

/**
 * The addresses a person gave, each of their messages' in one list, newest first, in the caller's
 * tenant run: inbox's addressesGivenBy.
 */
export type AddressesGiven = (personId: string) => Promise<string[][]>;
let addressesGiven: AddressesGiven | undefined;

/** The reader of the addresses a person gave: inbox sets it at the worker's start; undefined, none. */
export function useAddressesGiven(reader: AddressesGiven | undefined): void {
  addressesGiven = reader;
}

/** Whether the address's local part, letters only, holds the lead's first or family name. */
function holdsName(address: string, { first, last }: Names): boolean {
  const letters = localOf(address).replace(/[^a-z]/g, "");
  return [first, last].some((name) => name.length >= NAME_MIN && letters.includes(name));
}

/** The lead's own addresses of the messages, newest first, each once, the company's domain first. */
export function replyCandidates(
  given: readonly (readonly string[])[],
  names: Names,
  companyDomain: string,
): string[] {
  const picked = new Set<string>();
  for (const addresses of given) {
    const named = addresses.filter((address) => !isRoleAddress(address));
    const own = named.length === 1 ? named : named.filter((address) => holdsName(address, names));
    for (const address of own) picked.add(address);
  }
  const all = [...picked];
  const work = all.filter((address) => atDomain(address, companyDomain));
  return [...work, ...all.filter((address) => !work.includes(address))];
}

export const replySource = defineSource({
  name: REPLY,
  kind: "email",
  activityKind: "db",
  anyDomain: true,
  provenance: { source: SOURCE_CLASSES.reply, provider: REPLY },
  run: async ({ personId, firstName, lastName, companyDomain }, context) => {
    const reader = addressesGiven;
    if (reader === undefined) return { found: false } satisfies EmailSourceAnswer;
    const given = await context.tenant(() => reader(personId));
    const found = replyCandidates(given, namesOf(firstName, lastName), companyDomain);
    if (found.length === 0) return { found: false } satisfies EmailSourceAnswer;
    return { found: true, candidates: found.map((address) => ({ address })) };
  },
});
