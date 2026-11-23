// The never-contact checks and a person's touches (README.md "Public interface"; docs/flows.md "The
// check"), inside the caller's tenant run like every query of contacts: whether outreach to a person
// is allowed now, on a channel or on any (gamma-p2-040), for one person or a batch, or was by the
// list as it stood at an instant. No cache: every check reads the entries in the caller's run, so an
// entry added a moment before is seen (architecture §7.6, the just-in-time checks read the primary).
// A person the check does not know is suppressed: a check never fails open. A person is matched by
// their profile, each email address they hold (person_email_hashes, gamma-rf-040) and their company;
// one with no address is matched as before, and one without a profile by their addresses and their
// company (gamma-rf-050).
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { requireId } from "../rules.ts";
import {
  SUPPRESSION_BATCH_SIZE,
  SUPPRESSION_CHANNELS,
  type SuppressionChannel,
} from "./constants.ts";
import {
  companyHashes,
  decide,
  type MatchedEntry,
  notFound,
  profileHash,
  type Suppression,
} from "./matching.ts";

/**
 * What the check knows of a person: the hashes they are matched by, their own (the profile's and
 * each address's) and their company's, and their last touch.
 */
type Subject = {
  readonly personHashes: readonly string[];
  readonly companyHashes: readonly string[];
  readonly lastTouchAt: Date | null;
};
/** A check's options: whether it is for a new enrollment, and the channel it is for, if one. */
export type CheckOptions = {
  readonly newEnrollment: boolean;
  readonly channel?: SuppressionChannel;
};

const ENTRY_FIELDS = { layer: true, hash: true, channel: true } as const;

/**
 * Whether outreach to the person is allowed now, and why not. With `channel`, the entries on that
 * channel and on every channel count, and a refusal says on which (`channel`); with none, every
 * entry counts, the strictest answer, as before channels. The stops on every channel decide first,
 * person_not_found, opted_out, never_contact_person, never_contact_company, then, for a new
 * enrollment, recently_contacted (a touch less than CONTACTS_RECENT_TOUCH_DAYS ago); then an entry on one
 * channel (matching.ts decide). Anything but `newEnrollment: false` counts as a new enrollment, the
 * stricter answer. contacts_input_invalid naming `channel` for a channel off the list.
 */
export async function suppressionOf(personId: string, options: CheckOptions): Promise<Suppression> {
  const answers = await suppressionsOf([personId], options);
  return answers.get(personId) ?? notFound(channelOf(options));
}

/**
 * suppressionOf's answer for each person of the batch, by id, from one read of the persons (their
 * last touch with them), one of their email hashes, one of their companies and one of the entries,
 * whatever their number:
 * SUPPRESSION_BATCH_SIZE ids at most, more is contacts_input_invalid naming `personIds`. An id of no
 * person of the workspace answers person_not_found.
 */
export async function suppressionsOf(
  personIds: readonly string[],
  options: CheckOptions,
): Promise<Map<string, Suppression>> {
  const ids = requireBatch(personIds);
  const channel = channelOf(options);
  const newEnrollment = options?.newEnrollment !== false;
  const subjects = await subjectsOf(ids);
  const hashes = [...new Set([...subjects.values()].flatMap(hashesOf))];
  const entries =
    hashes.length === 0
      ? []
      : await tenantClient.suppressionEntry.findMany({
          where: { hash: { in: hashes }, removedAt: null },
          select: ENTRY_FIELDS,
        });
  const byHash = Map.groupBy(entries, ({ hash }) => hash);
  const now = new Date();
  const answer = (id: string): Suppression => {
    const subject = subjects.get(id);
    if (subject === undefined) return notFound(channel);
    const own: MatchedEntry[] = hashesOf(subject).flatMap((hash) => byHash.get(hash) ?? []);
    return decide({ ...subject, entries: own, newEnrollment, now, channel });
  };
  return new Map(ids.map((id) => [id, answer(id)]));
}

/**
 * The same answer against the list as it stood at `at`: the entries created at or before it and not
 * removed by then, against the person's company of now and the addresses recorded for them by then
 * (gamma-rf-040); never recently_contacted. With `channel`, as
 * suppressionOf reads one. What a report on past sends reads (beta-p7-020), per channel when it
 * passes one (gamma-p2-050). contacts_input_invalid naming `at` for no instant, `channel` for a
 * channel off the list.
 */
export async function suppressedAt(
  personId: string,
  at: Date,
  options: { readonly channel?: SuppressionChannel } = {},
): Promise<Suppression> {
  const instant = requireInstant(at);
  const channel = channelOf(options);
  const subject = (await subjectsOf([personId], instant)).get(personId);
  if (subject === undefined) return notFound(channel);
  const entries = await tenantClient.suppressionEntry.findMany({
    where: {
      hash: { in: hashesOf(subject) },
      createdAt: { lte: instant },
      OR: [{ removedAt: null }, { removedAt: { gt: instant } }],
    },
    select: ENTRY_FIELDS,
  });
  return decide({ ...subject, entries, newEnrollment: false, now: instant, channel });
}

/** The person's latest outbound touch, or null; person_not_found. */
export async function lastTouchAt(personId: string): Promise<Date | null> {
  const id = requireId("personId", personId);
  const person = await tenantClient.person.findFirst({
    where: { id },
    select: { lastTouchAt: true },
  });
  if (person === null) throw new AppError(errors.person_not_found);
  return person.lastTouchAt;
}

/**
 * Records an outbound touch: last_touch_at becomes the later of its value and `at`, in one statement,
 * so that no touch moves it back, whichever commits last; updated_at, the profile's, stays.
 * person_not_found; contacts_input_invalid naming `at` for no instant.
 */
export async function recordTouch(personId: string, at: Date): Promise<void> {
  const id = requireId("personId", personId);
  const instant = requireInstant(at);
  const { workspaceId } = currentTenant();
  const updated = await tenantClient.$executeRaw`
    UPDATE persons SET last_touch_at = GREATEST(last_touch_at, ${instant}::timestamptz)
    WHERE workspace_id = ${workspaceId} AND id = ${id}`;
  if (updated === 0) throw new AppError(errors.person_not_found);
}

/**
 * The hashes and last touch of each person of the workspace among the ids, by id: one read of the
 * persons, one of their email hashes (those recorded by `at`, when given) and one of their
 * companies. An id off the id rules, or of no person, is absent.
 */
async function subjectsOf(personIds: readonly unknown[], at?: Date): Promise<Map<string, Subject>> {
  const ids = [...new Set(personIds.flatMap((id) => knownId(id) ?? []))];
  if (ids.length === 0) return new Map();
  const persons = await tenantClient.person.findMany({
    where: { id: { in: ids } },
    select: { id: true, linkedinUrl: true, companyId: true, lastTouchAt: true },
  });
  const emails =
    persons.length === 0
      ? []
      : await tenantClient.personEmailHash.findMany({
          where: {
            personId: { in: persons.map(({ id }) => id) },
            ...(at !== undefined && { createdAt: { lte: at } }),
          },
          select: { personId: true, hash: true },
        });
  const emailsOf = Map.groupBy(emails, ({ personId }) => personId);
  const companyIds = [...new Set(persons.flatMap(({ companyId }) => companyId ?? []))];
  const companies =
    companyIds.length === 0
      ? []
      : await tenantClient.workspaceCompany.findMany({
          where: { id: { in: companyIds } },
          select: { id: true, domain: true, linkedinUrl: true },
        });
  const companyBy = new Map(companies.map((company) => [company.id, company]));
  return new Map(
    persons.map((person) => {
      const company = person.companyId === null ? undefined : companyBy.get(person.companyId);
      const addresses = (emailsOf.get(person.id) ?? []).map(({ hash }) => hash);
      // A person without a profile is matched by their addresses alone (gamma-rf-050).
      const profile = person.linkedinUrl === null ? [] : [profileHash(person.linkedinUrl)];
      const subject: Subject = {
        personHashes: [...profile, ...addresses],
        companyHashes: company === undefined ? [] : companyHashes(company),
        lastTouchAt: person.lastTouchAt,
      };
      return [person.id, subject];
    }),
  );
}

function hashesOf(subject: Subject): string[] {
  return [...subject.personHashes, ...subject.companyHashes];
}

/** The id as the rules take one, or null: an id off them names no person, so the check refuses. */
function knownId(value: unknown): string | null {
  try {
    return requireId("personId", value);
  } catch {
    return null;
  }
}

/** The batch's ids, SUPPRESSION_BATCH_SIZE at most; contacts_input_invalid naming `personIds`. */
function requireBatch(personIds: unknown): readonly string[] {
  if (Array.isArray(personIds) && personIds.length <= SUPPRESSION_BATCH_SIZE) return personIds;
  throw new AppError(errors.contacts_input_invalid, { details: { fields: ["personIds"] } });
}

/** The channel the check is for, or none; contacts_input_invalid naming `channel` off the list. */
function channelOf(options: { readonly channel?: unknown } | undefined) {
  const channel = options?.channel;
  if (channel === undefined) return undefined;
  const known = SUPPRESSION_CHANNELS.find((name) => name === channel);
  if (known !== undefined) return known;
  throw new AppError(errors.contacts_input_invalid, { details: { fields: ["channel"] } });
}

function requireInstant(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  throw new AppError(errors.contacts_input_invalid, { details: { fields: ["at"] } });
}
