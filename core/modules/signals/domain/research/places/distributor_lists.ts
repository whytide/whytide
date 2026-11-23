// A source type of the research plan's list (README.md "Web research"; gamma-wr-040).
import { definePlace } from "./_contract.ts";

definePlace(
  {
    id: "distributor_lists",
    labelKey: "signals.places.distributor_lists.label",
    shows:
      "The distributor lists of the makers of the products the member's own competes with: companies that already distribute a competing product and know its buyers.",
    finding:
      "Search for a distributors, stockists or authorised sellers page of a maker of a competing product, with the maker's name and the country.",
    pageKind: "company_list",
  },
  import.meta.url,
);
