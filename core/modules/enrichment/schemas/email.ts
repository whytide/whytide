// The Email panel's route answers and body (gamma-en-081; README "The Email panel"), from which the
// api host builds the OpenAPI document and the web its client: the person's held address with its
// kind, verification, source class and times, and the last lookup, its status and reason, never a
// finder's or verifier's name (RB-7.3.2); a request, "find" or "verify", answered with its id and
// status.
import { z } from "zod";
import { EMAIL_ACTIONS, LOOKUP_STATUSES, LOOKUP_TRIGGERS } from "../domain/lead/constants.ts";
import { CONTACT_KINDS, MISSING_REASONS, VERDICTS } from "../domain/lookup/constants.ts";

const time = z.iso.datetime();

export const leadEmailResponse = z.strictObject({
  /** The address "Verify again" checks, a work one first; null when the person holds none. */
  email: z
    .strictObject({
      address: z.string(),
      kind: z.enum(CONTACT_KINDS),
      verification: z.enum(VERDICTS),
      /** The contact point's class (`email_finder`…), never a provider's name. */
      sourceClass: z.string(),
      verifiedAt: time,
      acquiredAt: time,
      /** A personal address of a lead whose country needs consent, unused while the switch is off. */
      needsConsent: z.boolean(),
    })
    .nullable(),
  /** The person's latest lookup: its status and why it ended without an address, never a source. */
  lastLookup: z
    .strictObject({
      requestId: z.string(),
      trigger: z.enum(LOOKUP_TRIGGERS),
      status: z.enum(LOOKUP_STATUSES),
      reason: z.enum(MISSING_REASONS).nullable(),
      finishedAt: time.nullable(),
    })
    .nullable(),
});
export type LeadEmailResponse = z.infer<typeof leadEmailResponse>;

/** The person's phones (gamma-wr-100): each number a public page printed with them, and that page. */
export const leadPhonesResponse = z.strictObject({
  phones: z.array(
    z.strictObject({
      number: z.string(),
      /** The address of the page that printed the number (http or https), null when none was kept. */
      page: z.string().nullable(),
      acquiredAt: time,
    }),
  ),
});
export type LeadPhonesResponse = z.infer<typeof leadPhonesResponse>;

/** "find", a lookup at its price; "verify", the held address checked again, free. */
export const emailRequestBody = z.strictObject({ action: z.enum(EMAIL_ACTIONS) });
export type EmailRequestBody = z.infer<typeof emailRequestBody>;

export const emailRequestResponse = z.strictObject({
  requestId: z.string(),
  status: z.enum(LOOKUP_STATUSES),
});
export type EmailRequestResponse = z.infer<typeof emailRequestResponse>;
