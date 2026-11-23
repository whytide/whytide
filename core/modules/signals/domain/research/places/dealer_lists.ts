// A source type of the research plan's list (README.md "Web research"; gamma-wr-040).
import { definePlace } from "./_contract.ts";

definePlace(
  {
    id: "dealer_lists",
    labelKey: "signals.places.dealer_lists.label",
    shows:
      "The dealer or reseller lists that the makers of products sold beside the member's own publish: companies that already sell next to this product and reach the same buyers.",
    finding:
      "Search for a where-to-buy, dealers, resellers or partners page of a maker of a product sold beside the member's own, in each language of the audience.",
    pageKind: "company_list",
  },
  import.meta.url,
);
