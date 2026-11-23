// The priced actions of this module; the credits module assembles them at start (docs/rules/coding.md
// §3, §7). A verified email address costs ENRICHMENT_CREDITS_PER_EMAIL, its setting when the module
// loads, which credits' PRICE_ENRICHMENT_WORK_EMAIL overrides; every other end of a lookup is free
// (gamma-en-080).
import { definePrices } from "@whytide/platform";
import { settings } from "./settings.ts";

export const prices = definePrices(
  [
    {
      action: "enrichment.work_email",
      credits: settings.ENRICHMENT_CREDITS_PER_EMAIL,
      unit: "email",
    },
  ],
  import.meta.url,
);
