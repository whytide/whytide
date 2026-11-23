// A source type of the research plan's list (README.md "Web research"; gamma-wr-040).
import { definePlace } from "./_contract.ts";

definePlace(
  {
    id: "supplier_registries",
    labelKey: "signals.places.supplier_registries.label",
    shows:
      "Suppliers' registries and programme lists of public bodies, large buyers and certification schemes: companies already approved to supply the trade.",
    finding:
      "Search for a registry of approved suppliers, a supplier programme list or a certified-companies directory of the trade, with the country.",
    pageKind: "company_list",
  },
  import.meta.url,
);
