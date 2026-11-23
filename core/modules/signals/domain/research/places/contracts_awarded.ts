// A source type of the research plan's list (README.md "Web research"; gamma-wr-040).
import { definePlace } from "./_contract.ts";

definePlace(
  {
    id: "contracts_awarded",
    labelKey: "signals.places.contracts_awarded.label",
    shows:
      "Notices of contracts awarded in the trade: they name the company that won, the buyer and the subject, so they show who buys and who supplies.",
    finding:
      "Search for a contract award notice or a list of awarded contracts for what the product serves, in the language of the buying country.",
    pageKind: "notice",
  },
  import.meta.url,
);
