// The fixture workflows, run in Temporal's sandbox: ids in, or none for the global one, and their
// one activity's answer out. fixture_hold stays open until cancelled; its cancellation handler runs
// its activity once more, then the workflow ends cancelled. fixture_binds runs its activity once, with
// no retry, as the host's start order test needs.
import {
  CancellationScope,
  condition,
  isCancellation,
  proxyActivities,
} from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { activities } from "./index.ts";

const { fixture_tenant, fixture_global_probe, fixture_hold_step } = proxyActivities<
  ActivityFunctions<typeof activities>
>({
  startToCloseTimeout: "1 minute",
});

const { fixture_binds_probe } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

export async function fixture_echo(input: { workspaceId: string }) {
  return fixture_tenant(input);
}

export async function fixture_global(input: Record<string, never>) {
  return fixture_global_probe(input);
}

export async function fixture_hold(input: { workspaceId: string }) {
  await fixture_hold_step({ ...input, step: "started" });
  try {
    await condition(() => false);
  } catch (error) {
    if (isCancellation(error)) {
      const step = { ...input, step: "cancelled" as const };
      await CancellationScope.nonCancellable(() => fixture_hold_step(step));
    }
    throw error;
  }
}

export async function fixture_binds(input: { workspaceId: string }) {
  return fixture_binds_probe(input);
}
