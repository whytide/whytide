// The funnel route's answer (README.md "Routes"), from which the api host builds the OpenAPI
// document and the web its client: each campaign the member sees, by name, with the people
// enrolled, then on each channel those sent to, who accepted, replied and replied positively, each
// enrollment once per stage (domain/funnel.ts). Ids, names, codes and numbers only: no person, no
// message text, no email address.
import { z } from "zod";
import { CAMPAIGN_STATUSES } from "../domain/campaigns/constants.ts";

const count = z.int().min(0);

export const funnelResponse = z.strictObject({
  /** When the numbers were read. */
  asOf: z.iso.datetime(),
  /** By name, the seeded campaign's empty name first. Empty without a campaign the member sees. */
  campaigns: z.array(
    z.strictObject({
      campaignId: z.string(),
      /** Empty for the seeded campaign. */
      name: z.string(),
      status: z.enum(CAMPAIGN_STATUSES),
      /**
       * For a holder of campaigns.manage alone, who sees every campaign: its owner's name; null
       * once the owner is no member of the workspace, or gave no name. A Member's answer, her own
       * campaigns, has none.
       */
      ownerName: z.string().nullable().optional(),
      /** The enrollments that started. */
      enrolled: count,
      /** Enrollments with a LinkedIn step sent, then a connection request accepted, … */
      linkedin: z.strictObject({ sent: count, accepted: count, replied: count, positive: count }),
      /**
       * …and with an email sent; `accepted` always null, since an email has no acceptance: nullable
       * rather than null, a type the web's client (openapi-fetch's Readable) drops.
       */
      email: z.strictObject({
        sent: count,
        accepted: count.nullable(),
        replied: count,
        positive: count,
      }),
      /**
       * Every reply, each on the channel of the last step sent before it, or on none when nothing
       * was: a label neither out_of_office nor bounce; positive, the latest label interested.
       */
      total: z.strictObject({ replied: count, positive: count }),
    }),
  ),
});
export type FunnelResponse = z.infer<typeof funnelResponse>;
