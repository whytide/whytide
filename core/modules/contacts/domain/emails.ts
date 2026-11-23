// A person's email addresses as contacts knows them (README.md "Public interface"; docs/flows.md "The
// check"; gamma-rf-040): the keyed hash of each address a person holds, never the address, so that a
// block on an address stops the person on every channel, LinkedIn's too, whose gate knows no address.
// Enrichment keeps the address (its contact_points) and records it here first; contacts never imports
// enrichment. Inside the caller's tenant run, like every command of contacts (persons.ts).
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant } from "@whytide/platform";
import { errors } from "../errors.ts";
import { EMAIL_ADDRESS, EMAIL_MAX } from "./constants.ts";
import { hashOf } from "./hash.ts";
import { anyErased } from "./hashes.ts";
import { requireId } from "./rules.ts";
import { suppressAffectedLeads } from "./suppression/affected.ts";
import { EMAIL_CHANNEL, EVERY_CHANNEL } from "./suppression/constants.ts";
import type { EntryTarget } from "./suppression/matching.ts";

/** Who holds an address once recorded: the person, or another person of the workspace or an erased one. */
export type EmailHolder = "self" | "other_person";
/** What recordPersonEmail found. */
export type RecordedEmail = {
  readonly holder: EmailHolder;
  /** An active entry on every channel or on email holds the address: it is not to be kept. */
  readonly suppressed: boolean;
};

/**
 * An email address as contacts hashes one: trimmed and in lower case, nothing else folded (no `+tag`,
 * no dot); null for a text that is no address (EMAIL_ADDRESS, EMAIL_MAX characters at most).
 */
export function normalizeEmail(address: string): string | null {
  const normalized = typeof address === "string" ? address.trim().toLowerCase() : "";
  return normalized.length <= EMAIL_MAX && EMAIL_ADDRESS.test(normalized) ? normalized : null;
}

/** A person's never-contact entry on an email address, normalized; null for a value that is no address. */
export function emailTarget(value: string): EntryTarget | null {
  const email = normalizeEmail(value);
  if (email === null) return null;
  return {
    matchType: "email",
    linkedinUrl: null,
    domain: null,
    email,
    hash: hashOf("email", email),
  };
}

/**
 * Records that the person holds the address: its hash, INSERT … ON CONFLICT DO NOTHING, so that two
 * runs recording it at once keep one row. `holder` is `other_person`, and nothing is written, when
 * another person of the workspace holds it or an erased person left it (person_hashes); else `self`.
 * `suppressed`: an active entry on every channel or on email holds it, so it is not to be kept. When
 * an entry on every channel holds it and the person does, their lead becomes `suppressed` as an add
 * makes it (affected.ts), with the entry's reason, by the system; no event is published, and the
 * gate's own check refuses the person's next step. person_not_found; contacts_input_invalid naming
 * `address` for a text that is no address.
 */
export async function recordPersonEmail(input: {
  personId: string;
  address: string;
}): Promise<RecordedEmail> {
  const personId = requireId("personId", input?.personId);
  const target = emailTarget(input?.address);
  if (target === null) {
    throw new AppError(errors.contacts_input_invalid, { details: { fields: ["address"] } });
  }
  const person = await tenantClient.person.findFirst({
    where: { id: personId },
    select: { id: true },
  });
  if (person === null) throw new AppError(errors.person_not_found);
  return recordEmailHash(personId, target);
}

/**
 * recordPersonEmail's record of the person's address, for a person read already: what
 * upsertPersonFromSource calls with an address (persons.ts, gamma-rf-050).
 */
export async function recordEmailHash(
  personId: string,
  target: EntryTarget,
): Promise<RecordedEmail> {
  const holder = await holderOf(personId, target.hash);
  const entries = await tenantClient.suppressionEntry.findMany({
    where: { hash: target.hash, removedAt: null, channel: { in: [EVERY_CHANNEL, EMAIL_CHANNEL] } },
    select: { layer: true, channel: true },
  });
  const everywhere = entries.filter(({ channel }) => channel === EVERY_CHANNEL);
  if (holder === "self" && everywhere.length > 0) {
    const layer = everywhere.some((entry) => entry.layer === "opt_out") ? "opt_out" : "blocklist";
    const entry = {
      kind: "person",
      layer,
      channel: EVERY_CHANNEL,
      target,
      createdBy: null,
    } as const;
    await suppressAffectedLeads(entry);
  }
  return { holder, suppressed: entries.length > 0 };
}

/**
 * Writes the person's hash unless an erased person left it or the workspace holds it already; who
 * holds it then. A row that vanished meanwhile answers `other_person`: the address is not kept.
 */
async function holderOf(personId: string, hash: string): Promise<EmailHolder> {
  if (await anyErased([hash])) return "other_person";
  const { workspaceId } = currentTenant();
  const { count } = await tenantClient.personEmailHash.createMany({
    data: [{ workspaceId, personId, hash, createdAt: new Date() }],
    skipDuplicates: true,
  });
  if (count === 1) return "self";
  const held = await tenantClient.personEmailHash.findFirst({
    where: { hash },
    select: { personId: true },
  });
  return held?.personId === personId ? "self" : "other_person";
}
