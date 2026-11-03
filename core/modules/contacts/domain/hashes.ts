// The hash commands (docs/concepts.md "Hash"): what is left of a rejected candidate or an erased person,
// per workspace. Like every command of contacts they run inside the caller's tenant run, through
// tenantClient, and open none (persons.ts).
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { type DropReasons, type HashKind, hashOf, nextHash, normalizeProviderId } from "./hash.ts";
import { normalizeLinkedinUrl } from "./linkedin-url.ts";
import { parseInput, recordHashInput } from "./rules.ts";

/**
 * Records a hash of the URL or the provider id: a rejected candidate's for 90 days, with its drop
 * reasons added up, or an erased person's for good (hash.ts `nextHash`). linkedin_url_invalid for a
 * URL that is no profile; contacts_input_invalid for an empty id, or for both or neither given.
 */
export async function recordHash(input: {
  linkedinUrl?: string;
  providerId?: string;
  kind: HashKind;
  dropReasons?: readonly string[];
}): Promise<void> {
  const { linkedinUrl, providerId, kind, dropReasons } = parseInput(recordHashInput, input);
  const normalized =
    linkedinUrl === undefined
      ? normalizeProviderId(providerId ?? "")
      : normalizeLinkedinUrl(linkedinUrl);
  if (normalized === null && linkedinUrl !== undefined)
    throw new AppError(errors.linkedin_url_invalid);
  if (normalized === null) {
    throw new AppError(errors.contacts_input_invalid, { details: { fields: ["providerId"] } });
  }
  const of = linkedinUrl === undefined ? "pid" : "url";
  await writeHash(hashOf(of, normalized), kind, dropReasons, new Date());
}

/**
 * Which of the URLs, or the provider ids, have a live hash in the workspace, in one query: a map of
 * each input as given to its hash's kind. A value with none, or with an expired rejected candidate's,
 * and a URL that is no profile, are absent.
 */
export async function isHashed(
  input: { readonly linkedinUrls: readonly string[] } | { readonly providerIds: readonly string[] },
): Promise<ReadonlyMap<string, HashKind>> {
  const urls = "linkedinUrls" in input;
  const values = urls ? input.linkedinUrls : (input as { providerIds?: unknown }).providerIds;
  if (!Array.isArray(values)) {
    const fields = [urls ? "linkedinUrls" : "providerIds"];
    throw new AppError(errors.contacts_input_invalid, { details: { fields } });
  }
  const inputsOf = new Map<string, string[]>();
  for (const value of values as readonly string[]) {
    const normalized = urls ? normalizeLinkedinUrl(value) : normalizeProviderId(value);
    if (normalized === null) continue;
    const hash = hashOf(urls ? "url" : "pid", normalized);
    inputsOf.set(hash, [...(inputsOf.get(hash) ?? []), value]);
  }
  const found = new Map<string, HashKind>();
  if (inputsOf.size === 0) return found;
  const rows = await tenantClient.personHash.findMany({
    where: {
      hash: { in: [...inputsOf.keys()] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { hash: true, kind: true },
  });
  for (const { hash, kind } of rows)
    for (const value of inputsOf.get(hash) ?? []) found.set(value, kind);
  return found;
}

/** Deletes the workspace's rejected candidates' hashes whose 90 days are over; the count. */
export async function purgeExpiredHashes(): Promise<number> {
  const { count } = await tenantClient.personHash.deleteMany({
    where: { kind: "rejected_candidate", expiresAt: { lte: new Date() } },
  });
  return count;
}

/** Whether any of the hashes is an erased person's: upsertPersonFromSource refuses it. */
export async function anyErased(hashes: readonly string[]): Promise<boolean> {
  const row = await tenantClient.personHash.findFirst({
    where: { hash: { in: [...hashes] }, kind: "erased" },
    select: { id: true },
  });
  return row !== null;
}

/** Writes the hash's row as nextHash says, creating it or updating the workspace's one. */
export async function writeHash(
  hash: string,
  kind: HashKind,
  reasons: readonly string[],
  now: Date,
): Promise<void> {
  const stored = await tenantClient.personHash.findFirst({ where: { hash } });
  const state = stored && { ...stored, dropReasons: stored.dropReasons as DropReasons };
  const next = nextHash(state, kind, reasons, now);
  if (stored !== null) {
    await tenantClient.personHash.update({ where: { id: stored.id }, data: next });
    return;
  }
  const { workspaceId } = currentTenant();
  await tenantClient.personHash.create({
    data: { id: newId(ids.person_hash), workspaceId, hash, ...next },
  });
}
