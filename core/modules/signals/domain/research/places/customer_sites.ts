// A source type of the research plan's list (README.md "Web research"; gamma-wr-040).
import { definePlace } from "./_contract.ts";

definePlace(
  {
    id: "customer_sites",
    labelKey: "signals.places.customer_sites.label",
    shows:
      "The own sites and project news of companies that buy what the member's product serves: pages that show a project, a purchase or a need, and the company behind it.",
    finding:
      "Search for project news, case studies or a news page of a company that builds, buys or uses what the product serves, with the trade's words.",
    pageKind: "company_site",
  },
  import.meta.url,
);
