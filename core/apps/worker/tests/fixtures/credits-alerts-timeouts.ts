// The interceptor of credits-alerts.test.ts's timeout case (review-gaps-2), bundled into Temporal's
// sandbox beside the host's: credits_mail_alert is scheduled with a start-to-close of MAIL_TIMEOUT_MS
// and retried after RETRY's interval, so that an attempt that hangs times out within a second, as it
// would at the module's 5 minutes; the worker still ends the attempts at the provider kind's five.
// Every other activity goes as the workflow schedules it.
import type {
  ActivityInput,
  Next,
  WorkflowInterceptorsFactory,
  WorkflowOutboundCallsInterceptor,
} from "@temporalio/workflow";

const MAIL_TIMEOUT_MS = 300;
/** Temporal's retry policy, its interval in milliseconds. */
const RETRY = { initialInterval: 10, backoffCoefficient: 1 };

class ShortMail implements WorkflowOutboundCallsInterceptor {
  scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, "scheduleActivity">,
  ) {
    if (input.activityType !== "credits_mail_alert") return next(input);
    const options = { ...input.options, startToCloseTimeout: MAIL_TIMEOUT_MS, retry: RETRY };
    return next({ ...input, options });
  }
}

export const interceptors: WorkflowInterceptorsFactory = () => ({ outbound: [new ShortMail()] });
