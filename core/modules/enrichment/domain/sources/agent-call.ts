// callAgent's options for the `ai` sources (the website source, country-ai): none in the worker, so
// callAgent takes its own client and prices; a test's client and prices through testing/.
import type { CallOptions } from "@whytide/ai";

let callOptions: CallOptions | undefined;

/** For tests (testing/): callAgent's options, the test's client and prices; undefined restores. */
export function useAgentCall(next: CallOptions | undefined): void {
  callOptions = next;
}

/** The options an `ai` source passes callAgent. */
export function agentCallOptions(): CallOptions | undefined {
  return callOptions;
}
