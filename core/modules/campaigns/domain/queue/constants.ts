// The queue's values (README.md "The queue"), beside the code that reads them: due.ts and open.ts.
// The window itself is approvals' QUEUE_WINDOW_HOURS, in hours of ../constants.ts MS_PER_HOUR.

/**
 * What a step's turn in a queue run did: its item opened; the step passed over, no longer planned
 * and due, its enrollment ended or its person suppressed; or its sender account gone.
 */
export type QueueOutcome = "opened" | "passed_over" | "no_sender";
