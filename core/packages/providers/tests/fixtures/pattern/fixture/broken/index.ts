// A fixture adapter with a deliberate bug: greet() returns a field the port does not declare, the
// way a vendor object leaks. The contract suite fails on it and names the method.
import { defineAdapter } from "../../../../../_pattern/index.ts";
import { greeter } from "../echo/index.ts";
import { fixturePort } from "../port.ts";

export const brokenAdapter = defineAdapter(fixturePort, {
  name: "broken",
  create: () => {
    const inner = greeter();
    return {
      ...inner,
      greet: async (input) => {
        const vendorShaped = { ...(await inner.greet(input)), vendor_id: "grt_1" };
        return vendorShaped;
      },
    };
  },
});
