// The email source `linkedin-contact-info` (README "The source `linkedin-contact-info`";
// gamma-en-087): the email addresses a lead shows their 1st-degree connections in LinkedIn's
// "Contact info", read by the linkedin module's readContactEmails through the workspace's account the
// lead accepted, inside its daily reads. The owner's exception of 2026-11-13, for now, behind
// LINKEDIN_CONTACT_INFO_ENABLED, off by default: two gates, this source's and the linkedin module's.
// Off, the source is skipped with the outcome `disabled`, even when ENRICHMENT_EMAIL_SOURCES lists
// it, and nothing is read. Its candidates are the lead's own addresses, so it may propose any domain
// (`anyDomain`): the company's first, then the others, a personal one following the owner's UK and
// EU switch (../lookup/find.ts). Each is kept only on a verifier's `valid`, as `work_email` at the
// company's domain, else `personal_email`, with the class `linkedin_contact_info` and the LinkedIn
// adapter that read it as the provider. No account to read with is a skip (`not_connected`,
// `no_reads_left`), never a failure; the linkedin quota is its limit, so it has no allowance.
import { contactInfoEnabled, readContactEmails } from "@whytide/linkedin";
import { linkedinConfig } from "@whytide/providers";
import { CONTACT_INFO_SOURCE } from "../lookup/constants.ts";
import { atDomain } from "../lookup/key.ts";
import { defineSource, type EmailSourceAnswer } from "./define.ts";

export const linkedinContactInfoSource = defineSource({
  name: CONTACT_INFO_SOURCE.name,
  kind: "email",
  activityKind: "provider",
  anyDomain: true,
  provenance: { source: CONTACT_INFO_SOURCE.sourceClass, provider: CONTACT_INFO_SOURCE.provider },
  run: async ({ workspaceId, personId, companyDomain }, { tenant }): Promise<EmailSourceAnswer> => {
    if (!contactInfoEnabled()) return { found: false, outcome: CONTACT_INFO_SOURCE.disabled };
    const answer = await readContactEmails({ personId }, { workspaceId, tenant });
    if (answer.status !== "read") return { found: false, outcome: answer.status };
    if (answer.emails.length === 0) return { found: false };
    const work = answer.emails.filter((address) => atDomain(address, companyDomain));
    const others = answer.emails.filter((address) => !atDomain(address, companyDomain));
    const candidates = [...work, ...others].map((address) => ({ address }));
    const provider = linkedinConfig.PROVIDER_LINKEDIN;
    return { found: true, candidates, ...(provider !== undefined && { provider }) };
  },
});
