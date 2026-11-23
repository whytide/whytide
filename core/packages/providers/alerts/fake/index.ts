// The alerts fake (README.md "Adapters"): every text sent is kept in memory, in order, and read back
// with sent(), so a module test reads its alerts here; failNext(code) makes the next call fail with
// one of the port's codes, as for every fake, and the contract suite resets it before each case.
import { createFake, defineAdapter } from "../../_pattern/index.ts";
import { alertsPort } from "../port.ts";

export const alertsFake = createFake(alertsPort, {
  state: () => ({ sent: [] as string[] }),
  methods: (fake) => ({
    send: async ({ text }) => {
      fake.state.sent.push(text);
      return {};
    },
  }),
  helpers: (fake) => ({
    /** Every text sent since the last reset, in order. */
    sent: (): readonly string[] => [...fake.state.sent],
  }),
});

export type AlertsFake = typeof alertsFake;

export const alertsFakeAdapter = defineAdapter(alertsPort, {
  name: "fake",
  create: () => alertsFake,
});
