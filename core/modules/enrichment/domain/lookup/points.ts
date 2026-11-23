// The person's contact points as the lookup keeps them (docs/data.md "contact_points"), each function
// in the caller's tenant run: one address on one person, whatever its kind (the unique key on the
// workspace and the address, and a read of it first); the address a person may be written to, a
// work one first, a personal one only where it needs no consent; the cache entries of a person's
// key, one kind replacing the other, each for the days settings.ts reads (README "Settings").
import { recordPersonEmail } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { settings } from "../../settings.ts";
import { DAY_MS } from "../constants.ts";
import { type ContactKind, EMAIL_KINDS, LEGAL_BASIS } from "./constants.ts";
import type { Holder } from "./outcome.ts";

/** A verified address to keep: where it came from and when it was verified. */
export type Kept = {
  readonly address: string;
  readonly kind: ContactKind;
  readonly sourceClass: string;
  readonly provider: string;
  readonly verifiedAt: Date;
};

/** The earliest verification still trusted at `at`: ENRICHMENT_EMAIL_VALID_DAYS before it. */
export const validSince = (at: Date): Date =>
  new Date(at.getTime() - settings.ENRICHMENT_EMAIL_VALID_DAYS * DAY_MS);

/**
 * The person's active, valid contact point, a work one first, a personal one when it needs no
 * consent (`personalUsable`); with `since`, verified at or after it. Null for none.
 */
export async function usablePoint(
  personId: string,
  personalUsable: boolean,
  since?: Date,
): Promise<{ id: string; value: string; kind: ContactKind; verifiedAt: Date } | null> {
  const points = await tenantClient.contactPoint.findMany({
    where: {
      personId,
      status: "active",
      verification: "valid",
      verifiedAt: since === undefined ? { not: null } : { gte: since },
      // The email kinds only: a phone is never an address (gamma-wr-100).
      kind: { in: personalUsable ? [...EMAIL_KINDS] : ["work_email"] },
    },
    orderBy: [{ verifiedAt: "desc" }, { id: "asc" }],
  });
  const usable = points.flatMap(({ kind, verifiedAt, ...rest }) =>
    kind === "phone" || verifiedAt === null ? [] : [{ ...rest, kind, verifiedAt }],
  );
  return usable.find((point) => point.kind === "work_email") ?? usable[0] ?? null;
}

/** The person's active address whatever its verification, a work one first, never a phone: a re-verification's. */
export async function activePoint(
  personId: string,
): Promise<{ id: string; kind: ContactKind } | null> {
  const points = await tenantClient.contactPoint.findMany({
    where: { personId, status: "active", kind: { in: [...EMAIL_KINDS] } },
    select: { id: true, kind: true },
    orderBy: { createdAt: "asc" },
  });
  const held = points.flatMap(({ id, kind }) => (kind === "phone" ? [] : [{ id, kind }]));
  return held.find((point) => point.kind === "work_email") ?? held[0] ?? null;
}

/**
 * The verified address kept on the person: their own active one renewed, or a new contact point;
 * none when another person holds it, or the person's own is bounced or opted out. A race on the
 * unique key ends the same way: ON CONFLICT DO NOTHING leaves the run usable.
 * `created`: true only when this call made the contact point (gamma-rf-030).
 * Before it keeps one, the address's hash is recorded for the person (contacts' recordPersonEmail,
 * gamma-rf-040): held by another person of the workspace or left by an erased one, `other_person`;
 * blocked on every channel or on email, `suppressed`, and nothing is kept.
 */
export async function keepAddress(
  personId: string,
  kept: Kept,
): Promise<{ holder: Holder; contactPointId: string | null; created?: boolean }> {
  const { address, kind, sourceClass, provider, verifiedAt } = kept;
  const held = await tenantClient.contactPoint.findFirst({ where: { value: address } });
  // The address's hash, the person's (gamma-rf-040): a blocked address is not kept.
  if (held === null || held.personId === personId) {
    const recorded = await recordPersonEmail({ personId, address });
    if (recorded.holder === "other_person") return { holder: "other_person", contactPointId: null };
    if (recorded.suppressed) return { holder: "suppressed", contactPointId: null };
  }
  if (held !== null) {
    if (held.personId !== personId) return { holder: "other_person", contactPointId: null };
    if (held.status !== "active") return { holder: "inactive", contactPointId: null };
    await tenantClient.contactPoint.update({
      where: { id: held.id },
      data: { verification: "valid", verifiedAt, updatedAt: verifiedAt },
    });
    return { holder: "free", contactPointId: held.id };
  }
  const id = newId(ids.contact_point);
  const { workspaceId } = currentTenant();
  const { count } = await tenantClient.contactPoint.createMany({
    data: [
      {
        id,
        workspaceId,
        personId,
        kind,
        value: address,
        verification: "valid",
        verifiedAt,
        sourceClass,
        provider,
        acquiredAt: verifiedAt,
        legalBasis: LEGAL_BASIS,
        createdAt: verifiedAt,
        updatedAt: verifiedAt,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1
    ? { holder: "free", contactPointId: id, created: true }
    : { holder: "other_person", contactPointId: null };
}

/**
 * The person's key's cache entry of `kind`, written at `at` for its days, and the other kind's entry
 * deleted: an `email` entry holds the address for ENRICHMENT_EMAIL_VALID_DAYS, a `negative` one the
 * reason for ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS.
 */
export async function writeCache(
  entry: {
    readonly personId: string;
    readonly keyHash: string;
    readonly provider: string;
    readonly at: Date;
  } & (
    | { readonly kind: "email"; readonly address: string }
    | { readonly kind: "negative"; readonly reason: string }
  ),
): Promise<void> {
  const { personId, keyHash, provider, at, kind } = entry;
  const days =
    kind === "email"
      ? settings.ENRICHMENT_EMAIL_VALID_DAYS
      : settings.ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS;
  const values = {
    personId,
    provider,
    retrievedAt: at,
    expiresAt: new Date(at.getTime() + days * DAY_MS),
    value: kind === "email" ? entry.address : null,
    verification: kind === "email" ? ("valid" as const) : null,
    reason: kind === "negative" ? entry.reason : null,
  };
  const other = kind === "email" ? "negative" : "email";
  const { workspaceId } = currentTenant();
  await tenantClient.enrichmentCacheEntry.deleteMany({ where: { keyHash, kind: other } });
  await tenantClient.enrichmentCacheEntry.upsert({
    where: { workspaceId_kind_keyHash: { workspaceId, kind, keyHash } },
    create: { id: newId(ids.enrichment_cache_entry), workspaceId, keyHash, kind, ...values },
    update: values,
  });
}
