// inbox's workflows, run in Temporal's sandbox: one message the receiver kept, through the activity
// inbox_store (README.md "The store"); one reply's mail to its account's owner, through the activity
// inbox_mail_reply (README.md "The reply mail"). Ids in, ids, booleans and codes out: never a text.
import { proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import { MAIL_TIMEOUT, STORE_TIMEOUT } from "./constants.ts";
import type { activities, MailInput, StoreInput } from "./index.ts";

const { inbox_store } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: STORE_TIMEOUT,
});

export async function inbox_store_message(input: StoreInput) {
  return inbox_store(input);
}

const { inbox_mail_reply } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: MAIL_TIMEOUT,
});

export async function inbox_reply_mail(input: MailInput) {
  return inbox_mail_reply(input);
}
