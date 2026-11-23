// A person's phone as enrichment keeps it (README "A person's phone"; gamma-wr-100), in the caller's
// tenant run: a number a public page printed with the person, kept as a contact point of kind `phone`,
// with the page it came from. Cleaned by form only (form.ts). One number on one person, as one address
// is: a number another person holds, in any way of printing it, is not kept again. Nothing is kept for
// a person the never-contact list holds, on any channel, nor for a person who is gone. Whytide calls
// and messages no number. No number, page or name reaches a log line, a span or an event: the answer
// is an outcome and an id.
import { errors as contactsErrors, getPerson, suppressionOf } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { currentTenant, isAppError, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { LEGAL_BASIS } from "../lookup/constants.ts";
import { PHONE_DIGITS_MIN, PHONE_PROVIDER, PHONE_SOURCE_CLASS } from "./constants.ts";
import { cleanPhone, pageOfPhone, samePhone, significant } from "./form.ts";

/**
 * How keeping a number ended: `kept` (a new contact point), `known` (the person holds it already),
 * `other_person` (another person of the workspace holds it), `suppressed` (the person is on the
 * never-contact list), `gone` (no such person), `invalid` (not a number by its form).
 */
export type PhoneOutcome = {
  readonly outcome: "kept" | "known" | "other_person" | "suppressed" | "gone" | "invalid";
  readonly contactPointId: string | null;
};
const ended = (outcome: PhoneOutcome["outcome"], contactPointId: string | null = null) => ({
  outcome,
  contactPointId,
});

/** The number a page printed with the person, kept for them; `page` is the page's address. */
export async function keepPhone(
  personId: string,
  given: { readonly number: string; readonly page: string },
  at: Date = new Date(),
): Promise<PhoneOutcome> {
  const value = cleanPhone(given.number);
  if (value === null) return ended("invalid");
  try {
    await getPerson(personId);
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return ended("gone");
    throw error;
  }
  // Every entry counts, whatever its channel: the strictest answer.
  if ((await suppressionOf(personId, { newEnrollment: false })).suppressed) {
    return ended("suppressed");
  }
  const holders = await tenantClient.contactPoint.findMany({
    where: { kind: "phone", value: { endsWith: significant(value).slice(-PHONE_DIGITS_MIN) } },
    select: { id: true, personId: true, value: true, pageUrl: true },
  });
  const same = holders.filter((held) => samePhone(held.value, value));
  if (same.some((held) => held.personId !== personId)) return ended("other_person");
  const page = pageOfPhone(given.page);
  const own = same[0];
  if (own !== undefined) {
    // The page that printed it is kept when the first time there was none.
    if (own.pageUrl === null && page !== null) {
      await tenantClient.contactPoint.update({
        where: { id: own.id },
        data: { pageUrl: page, updatedAt: at },
      });
    }
    return ended("known", own.id);
  }
  const id = newId(ids.contact_point);
  const { count } = await tenantClient.contactPoint.createMany({
    data: [
      {
        ...{ id, workspaceId: currentTenant().workspaceId, personId, kind: "phone", value },
        ...{ sourceClass: PHONE_SOURCE_CLASS, provider: PHONE_PROVIDER, pageUrl: page },
        ...{ acquiredAt: at, legalBasis: LEGAL_BASIS, createdAt: at, updatedAt: at },
      },
    ],
    skipDuplicates: true,
  });
  // A race on the unique key: another run kept the number first.
  return count === 1 ? ended("kept", id) : ended("other_person");
}

/** A person's active phones with the page each came from, the oldest first; for the lead page. */
export async function phonesOf(personId: string): Promise<
  readonly {
    readonly number: string;
    readonly page: string | null;
    readonly acquiredAt: Date;
  }[]
> {
  const points = await tenantClient.contactPoint.findMany({
    where: { personId, kind: "phone", status: "active" },
    select: { value: true, pageUrl: true, acquiredAt: true },
    orderBy: [{ acquiredAt: "asc" }, { id: "asc" }],
  });
  return points.map(({ value, pageUrl, acquiredAt }) => ({
    number: value,
    page: pageUrl,
    acquiredAt,
  }));
}
