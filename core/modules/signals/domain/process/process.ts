// The candidates whose profiles were read (README.md "Processing"; docs/flows.md), a chunk at a time
// in one tenant run, the hard filters and the noise rules of the run's audience (its agent's, else
// the default; agents.ts, gamma-p5-045) prepared once for it. A profile that names the own company
// is dropped, and one at a competitor (noise.ts; a recruiter or a job seeker is the assessment's
// since signals-triage-ai); one the filters stop, by its country (the title is the assessment's,
// title-check-ai), leaves a salted hash with the reason (contacts' recordHash) and nothing else; one
// that passes becomes or updates a person with linkedin's provenance and its member id under
// `unipile`, which campaigns' first invite reads (gamma-p5-020), its company, its lead (source
// `signal`, with the source's label and the candidate's post, which contacts' lead list shows), an
// event (one per dedupe key) and its evidence. The chunk's new leads go to qualification as
// signals.person_found, the known persons' new events as a re-score request; its staging rows are
// deleted and its counts added to the run's. An event's id carries its candidate's ULID (ids.ts).
import { json } from "node:stream/consumers";
import {
  errors as contactsErrors,
  countryOf,
  createLeadForPerson,
  linkPersonToCompany,
  recordHash,
  upsertCompany,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { type ProfileFile, profileFile } from "@whytide/linkedin";
import { getCompanyDomain } from "@whytide/onboarding";
import { isAppError, newId, publish } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import {
  type PreparedHardFilters,
  prepareHardFilters,
  requestRescore,
} from "@whytide/qualification";
import { events } from "../../events.ts";
import { eventIdOf, ids } from "../../ids.ts";
import type { SourceKind } from "../../sources/_contract.ts";
import { sourceKind } from "../../sources/registry.ts";
import { audienceOf } from "../agents.ts";
import { addCounts, type RunRef } from "../runs.ts";
import { MEMBER_REF_KEY, profileKeys } from "./keys.ts";
import type { NoiseRules } from "./noise.ts";
import { dedupeKeyOf, excerptOf, ownCompanyRule } from "./rules.ts";
import { noiseRulesOf } from "./select.ts";

type Outcome =
  | "dropped_unread"
  | "dropped_own"
  | "dropped_competitor"
  | "dropped_hashed"
  | "dropped_filtered"
  | "dropped_known"
  | "created"
  | "attached";
/** A staging row, as the processing reads it. */
type Staged = {
  readonly id: string;
  readonly providerMemberRef: string;
  readonly profileUrl: string;
  readonly name: string;
  readonly headline: string;
  readonly reaction: string;
  readonly commentText: string | null;
  readonly engagedAt: Date;
  readonly objectUrl: string | null;
  readonly postExcerpt: string | null;
};
/** A company the profile names that contacts refuses (a page off /company/, no domain): skipped. */
const NO_COMPANY: ReadonlySet<string> = new Set([
  contactsErrors.linkedin_url_invalid,
  contactsErrors.contacts_input_invalid,
]);
type Chunk = {
  readonly ref: RunRef;
  readonly kind: SourceKind;
  /** The source's post, for a row staged before gamma-p5-020; every other row names its own. */
  readonly objectUrl: string;
  /** The source's label, which contacts' lead list shows with the candidate's post. */
  readonly label: string;
  readonly filters: PreparedHardFilters;
  readonly noise: NoiseRules;
  readonly own: (text: string | null | undefined) => boolean;
  readonly now: Date;
};

/** The chunk's profile files, read outside any run; a candidate whose read was refused has none. */
export async function readProfiles(
  workspaceId: string,
  runId: string,
  candidateIds: readonly string[],
): Promise<Map<string, ProfileFile>> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const profiles = new Map<string, ProfileFile>();
  for (const id of candidateIds) {
    const key = profileKeys(runId, id).rawKey;
    const file = await files.get({ workspaceId, key }).catch((error: unknown) => {
      if (isAppError(error) && error.code === filesPort.errors.files_not_found) return null;
      throw error;
    });
    if (file !== null) profiles.set(id, profileFile.parse(await json(file.body)));
  }
  return profiles;
}

/** The chunk processed in the caller's tenant run; the candidates it found still staged. */
export async function processCandidates(
  ref: RunRef,
  candidateIds: readonly string[],
  profiles: ReadonlyMap<string, ProfileFile>,
  ownName: string | null,
  now = new Date(),
): Promise<{ processed: number }> {
  const { workspaceId, sourceId, runId } = ref;
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  const staged = await tenantClient.signalCandidate.findMany({
    where: { runId, id: { in: [...candidateIds] } },
    orderBy: { id: "asc" },
  });
  if (source === null || staged.length === 0) return { processed: 0 };
  const kind = sourceKind(source.kind);
  const { icp } = await audienceOf(workspaceId, ref.playbookId);
  const own = ownCompanyRule({ domain: await getCompanyDomain(), name: ownName });
  const objectUrl = kind.event.objectOf?.(source.config) ?? "";
  const { label } = source;
  const filters = prepareHardFilters(icp);
  const chunk = { ref, kind, objectUrl, label, filters, noise: await noiseRulesOf(icp), own, now };
  const counts: Record<string, number> = { profiles_read: 0 };
  const found: string[] = [];
  const known: string[] = [];
  for (const candidate of staged) {
    const profile = profiles.get(candidate.id);
    if (profile !== undefined) counts.profiles_read = (counts.profiles_read ?? 0) + 1;
    const { outcome, personId } = await processOne(chunk, candidate, profile);
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    if (outcome === "created" && personId !== undefined) found.push(personId);
    if (outcome === "attached" && personId !== undefined) known.push(personId);
  }
  await tenantClient.signalCandidate.deleteMany({
    where: { runId, id: { in: staged.map(({ id }) => id) } },
  });
  if (found.length > 0) {
    const outbox = outboxWriter(tenantClient, workspaceId);
    await publish(outbox, events["signals.person_found"], { workspaceId, personIds: found });
  }
  if (known.length > 0) await requestRescore({ personIds: known });
  await addCounts(runId, counts);
  return { processed: staged.length };
}

/** One candidate: dropped with its reason, or kept, its person created or known already. */
async function processOne(
  { ref, kind, objectUrl, label, filters, noise, own, now }: Chunk,
  candidate: Staged,
  profile: ProfileFile | undefined,
): Promise<{ outcome: Outcome; personId?: string }> {
  if (profile === undefined) return { outcome: "dropped_unread" };
  if ([profile.headline, profile.companyName, profile.companyUrl].some(own)) {
    return { outcome: "dropped_own" };
  }
  const noisy = noise.profile(profile);
  if (noisy !== null) return { outcome: noisy };
  const locationCountry = countryOf(profile.locationText);
  // The country only: the title is the assessment's (title-check-ai), and no company row yet.
  const filtered = filters({ locationCountry }, null);
  if (!filtered.passed) {
    const rejected = {
      providerId: candidate.providerMemberRef,
      kind: "rejected_candidate" as const,
    };
    await recordHash({ ...rejected, dropReasons: [filtered.reason] });
    return { outcome: "dropped_filtered" };
  }
  const personId = await upsertPerson(profile);
  if (personId === null) return { outcome: "dropped_hashed" };
  await linkCompany(personId, profile);
  const at = candidate.engagedAt;
  const url = candidate.objectUrl ?? objectUrl;
  const source = { kind: "signal" as const, ref: ref.sourceId, at, label, url };
  const { created } = await createLeadForPerson({ personId, source });
  const { providerMemberRef: actor, reaction: role } = candidate;
  // The candidate's ULID: its credit's subject is the candidate, whose row goes with the run, so the
  // event names it for the lead's cost (personReads, beta-p1-090).
  const event = {
    id: eventIdOf(candidate.id),
    workspaceId: ref.workspaceId,
    personId,
    sourceId: ref.sourceId,
    runId: ref.runId,
    kind: kind.event.kind,
    dedupeKey: dedupeKeyOf({ kind: kind.event.kind, actor, objectUrl: url, role }),
    occurredAt: candidate.engagedAt,
  };
  const { count } = await tenantClient.signalEvent.createMany({
    data: [event],
    skipDuplicates: true,
  });
  if (count === 0) return { outcome: "dropped_known", personId };
  const { profileUrl, name, headline, commentText, engagedAt, postExcerpt } = candidate;
  const evidence = kind.evidenceOf({
    ...{ providerMemberRef: actor, profileUrl, name, headline, reaction: role, engagedAt },
    ...(commentText === null ? {} : { commentText }),
    ...(postExcerpt === null ? {} : { postExcerpt }),
    objectUrl: url,
  });
  // captured_at is set once, here, with its new event, and never moves (alpha-p10-020; security §2):
  // a known event stops above, a later engagement is an event of its own, a re-import writes no
  // evidence, and `create`, never an upsert, fails on a row the event has rather than reset its time.
  await tenantClient.evidence.create({
    data: {
      id: newId(ids.evidence),
      workspaceId: ref.workspaceId,
      eventId: event.id,
      url: evidence.url,
      excerpt: excerptOf(evidence.ownWords ?? evidence.commentText),
      commentText: evidence.commentText ?? null,
      postExcerpt: excerptOf(evidence.postExcerpt),
      reaction: evidence.reaction,
      author: evidence.author,
      capturedAt: now,
    },
  });
  return { outcome: created ? "created" : "attached", personId };
}

/**
 * The person of the profile, linkedin's provenance, its member id under campaigns' key, `unipile`,
 * as campaigns' storeMemberRef keeps it; null when contacts has it erased.
 */
async function upsertPerson(profile: ProfileFile): Promise<string | null> {
  const { profileUrl, firstName, lastName, headline, title, companyName, locationText } = profile;
  const values = { firstName, lastName, headline, title, companyName, locationText };
  const fetchedAt = new Date(profile.fetchedAt);
  const providerId = profile.providerMemberRef;
  try {
    const { person } = await upsertPersonFromSource({
      source: "linkedin",
      provider: MEMBER_REF_KEY,
      profile: { linkedinUrl: profileUrl, providerId, ...values, fetchedAt },
    });
    return person.id;
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_erased) return null;
    throw error;
  }
}

/** The profile's company, by its LinkedIn page or its website's domain, linked; none without either. */
async function linkCompany(personId: string, profile: ProfileFile): Promise<void> {
  const { companyName: name, companyUrl } = profile;
  if (name.trim() === "" || companyUrl === undefined) return;
  const page = /(?:^|\.)linkedin\.com$/.test(new URL(companyUrl).hostname);
  const fetchedAt = new Date(profile.fetchedAt);
  const company = {
    name,
    ...(page ? { linkedinUrl: companyUrl } : { domain: companyUrl }),
    fetchedAt,
  };
  try {
    const { company: stored } = await upsertCompany({
      source: "linkedin",
      provider: null,
      company,
    });
    await linkPersonToCompany({ personId, companyId: stored.id });
  } catch (error) {
    if (!isAppError(error) || !NO_COMPANY.has(error.code)) throw error;
  }
}
