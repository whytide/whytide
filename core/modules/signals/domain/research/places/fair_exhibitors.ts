// A source type of the research plan's list (README.md "Web research"; gamma-wr-040).
import { definePlace } from "./_contract.ts";

definePlace(
  {
    id: "fair_exhibitors",
    labelKey: "signals.places.fair_exhibitors.label",
    shows:
      "The exhibitor lists of trade fairs and shows of the trade: companies that pay to be seen by the trade's buyers and partners.",
    finding:
      "Search for the exhibitor list or catalogue of a trade fair or show of the trade, held in the audience's countries, with the year.",
    pageKind: "company_list",
  },
  import.meta.url,
);
