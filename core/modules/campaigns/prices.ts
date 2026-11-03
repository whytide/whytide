// The priced actions of this module; the credits module assembles them at start (docs/rules/coding.md
// §3, §7). A send, a connection request or a message, costs CAMPAIGNS_CREDITS_PER_LINKEDIN_SEND, its
// setting when the module loads, which credits' PRICE_CAMPAIGNS_LINKEDIN_SEND overrides; a
// withdrawal and a check cost nothing (beta-p4-020).
import { definePrices } from "@whytide/platform";
import { LINKEDIN_SEND_ACTION, LINKEDIN_SEND_UNIT } from "./domain/send/constants.ts";
import { settings } from "./settings.ts";

export const prices = definePrices(
  [
    {
      action: LINKEDIN_SEND_ACTION,
      credits: settings.CAMPAIGNS_CREDITS_PER_LINKEDIN_SEND,
      unit: LINKEDIN_SEND_UNIT,
    },
  ],
  import.meta.url,
);
