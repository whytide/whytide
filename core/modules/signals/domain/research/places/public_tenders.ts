// A source type of the research plan's list (README.md "Web research"; gamma-wr-040).
import { definePlace } from "./_contract.ts";

definePlace(
  {
    id: "public_tenders",
    labelKey: "signals.places.public_tenders.label",
    shows:
      "Public buyers' tenders and calls for bids in the trade: notices that name the buyer that wants what the member's product serves, and sometimes the bidders.",
    finding:
      "Search for a tender, a call for bids or a procurement notice for what the product serves, in the language of the buying country.",
    pageKind: "notice",
  },
  import.meta.url,
);
