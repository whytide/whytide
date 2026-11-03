// The second fixture adapter: an implementation with no vendor and no fake controls, the shape a
// real adapter has. greeter() is what the other fixture adapters build on.
import { AppError } from "@whytide/platform";
import { defineAdapter, type PortImplementation } from "../../../../../_pattern/index.ts";
import { fixturePort } from "../port.ts";

export function greeter(): PortImplementation<typeof fixturePort> {
  let greetings = 0;
  return {
    greet: async ({ name, shout }) => {
      if (name === "nobody") throw new AppError(fixturePort.errors.fixture_not_found);
      greetings += 1;
      const greeting = `hello ${name}`;
      return { greeting: shout ? greeting.toUpperCase() : greeting };
    },
    count: async () => ({ greetings }),
  };
}

export const echoAdapter = defineAdapter(fixturePort, { name: "echo", create: greeter });
