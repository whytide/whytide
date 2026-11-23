// A source type of the research plan's list (README.md "Web research"; gamma-wr-040).
import { definePlace } from "./_contract.ts";

definePlace(
  {
    id: "web_search",
    labelKey: "signals.places.web_search.label",
    shows:
      "Companies that sell or make what the member's product serves, found by a plain web search with the trade's own words; each result is usually a company's own site or a page about it.",
    finding:
      "Search the trade's own words in each language and country of the audience, with the offer's products, the buyers' roles and the words buyers use for what they need.",
    pageKind: "company_site",
  },
  import.meta.url,
);
