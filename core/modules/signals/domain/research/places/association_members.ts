// A source type of the research plan's list (README.md "Web research"; gamma-wr-040).
import { definePlace } from "./_contract.ts";

definePlace(
  {
    id: "association_members",
    labelKey: "signals.places.association_members.label",
    shows:
      "The member lists of trade associations, chambers and clusters of the trade: companies that belong to the trade in a country or a region.",
    finding:
      "Search for the members directory of an association, a chamber of commerce or a cluster of the trade, in the language and country of the audience.",
    pageKind: "company_list",
  },
  import.meta.url,
);
