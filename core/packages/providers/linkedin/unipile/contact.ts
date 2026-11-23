// A member's "Contact info" emails on Unipile (README.md "Covers"; gamma-en-087, the owner's exception
// of 2026-11-13, behind LINKEDIN_CONTACT_INFO_ENABLED): getContactEmails asks Unipile's profile,
// GET /users/{provider_id}?account_id=&notify=false ("Retrieve a profile", developer.unipile.com,
// read 2026-11-14), with no linkedin_sections: the section comes as the answer's top-level
// `contact_info`, which LinkedIn fills for a 1st-degree connection only. It maps
// `contact_info.emails` alone, for a member whose network_distance is FIRST_DEGREE: each trimmed and
// lower-cased, kept when it is an address, each once, the first CONTACT_EMAILS_MAX. A member who is
// not a relation, or shows no email, answers none. The section's phones, addresses (`adresses`),
// socials, the birthdate and every other field stop here: the vendor schema reads none of them.
// Errors map as every read's (client.ts).
import { z } from "zod";
import type { PortImplementation } from "../../_pattern/index.ts";
import { CONTACT_EMAILS_MAX } from "../constants.ts";
import { linkedinPort } from "../port.ts";
import { type Client, offShape, segment } from "./client.ts";
import { RELATION } from "./constants.ts";

type GetContactEmails = PortImplementation<typeof linkedinPort>["getContactEmails"];

/** A profile as this read takes it: the member's distance and the section's emails, nothing else. */
const vendorContact = z.object({
  network_distance: z.string().nullish(),
  contact_info: z.object({ emails: z.array(z.unknown()).nullish() }).nullish(),
});
const address = linkedinPort.methods.getContactEmails.output.shape.emails.element;

export function getContactEmails(call: Client): GetContactEmails {
  return async ({ providerAccountRef, memberRef }) => {
    const method = "getContactEmails";
    // notify=false: the read shows the member no profile view.
    const query = { account_id: providerAccountRef, notify: "false" };
    const answer = await call(method, { path: `/users/${segment(memberRef, method)}`, query });
    const found = vendorContact.safeParse(answer);
    if (!found.success) throw offShape(method);
    if (found.data.network_distance !== RELATION) return { emails: [] };
    const emails = new Set<string>();
    for (const given of found.data.contact_info?.emails ?? []) {
      if (typeof given !== "string") continue;
      const kept = address.safeParse(given.trim().toLowerCase());
      if (kept.success) emails.add(kept.data);
    }
    return { emails: [...emails].slice(0, CONTACT_EMAILS_MAX) };
  };
}
