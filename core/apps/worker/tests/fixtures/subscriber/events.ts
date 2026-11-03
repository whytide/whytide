// The second fixture module: its events.ts subscribes to the first's event through that module's
// index, as a module does through `@whytide/<name>`. The deliveries are kept on globalThis, so that
// a second copy of this file would add to the same list, which tests/host.test.ts counts.
import { subscribe } from "@whytide/platform";
import { events } from "../module/index.ts";

const shared = globalThis as unknown as Record<symbol, string[] | undefined>;
export const received: string[] = (shared[Symbol.for("whytide.worker.fixture.subscriber")] ??= []);

subscribe(events["fixture.pinged"], async (_payload, { id }) => {
  received.push(id);
});
