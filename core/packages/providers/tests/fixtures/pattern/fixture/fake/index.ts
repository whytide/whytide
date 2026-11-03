// The fixture port's fake (README.md "The fake"): in-memory state read on every call, the recorded
// calls and failNext from createFake, one helper of its own.
import { AppError } from "@whytide/platform";
import { createFake, defineAdapter } from "../../../../../_pattern/index.ts";
import { fixturePort } from "../port.ts";

export const fixtureFake = createFake(fixturePort, {
  state: () => ({ greeted: [] as string[] }),
  methods: (fake) => ({
    greet: async ({ name, shout }) => {
      if (name === "nobody") throw new AppError(fixturePort.errors.fixture_not_found);
      fake.state.greeted.push(name);
      const greeting = `hello ${name}`;
      return { greeting: shout ? greeting.toUpperCase() : greeting };
    },
    count: async () => ({ greetings: fake.state.greeted.length }),
  }),
  helpers: (fake) => ({ greeted: () => [...fake.state.greeted] }),
});

export const fixtureFakeAdapter = defineAdapter(fixturePort, {
  name: "fake",
  create: () => fixtureFake,
});
