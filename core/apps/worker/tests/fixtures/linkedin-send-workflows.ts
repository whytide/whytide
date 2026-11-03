// The bundle entry of the send activities' tests (fixtures/linkedin-send.ts useTemporal), run in
// Temporal's sandbox: each call in turn, by the activity's name, as campaigns' sender will make them,
// with the start-to-close timeout callers give the send activities (SEND_CALL_MARGIN_MS, 2 minutes)
// and Temporal's own retries; the answers, and the run's id, whose history the test reads.
import { proxyActivities, workflowInfo } from "@temporalio/workflow";

type Call = { readonly activity: string; readonly input: Record<string, unknown> };
const linkedin = proxyActivities<Record<string, (input: unknown) => Promise<unknown>>>({
  startToCloseTimeout: "2 minutes",
});

export async function linkedin_send_probe(input: { calls: Call[] }) {
  const answers: unknown[] = [];
  for (const call of input.calls) answers.push(await linkedin[call.activity]?.(call.input));
  return { workflowId: workflowInfo().workflowId, answers };
}
