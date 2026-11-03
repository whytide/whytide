// fixture_echo after a non-deterministic edit: a timer before the activity, which the recorded
// history does not have, so its replay fails (tests/replay.test.ts).
import { proxyActivities, sleep } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { activities } from "./index.ts";

const { fixture_tenant } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "1 minute",
});

export async function fixture_echo(input: { workspaceId: string }) {
  await sleep("1 second");
  return fixture_tenant(input);
}
