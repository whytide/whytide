// The classifier's gate (agents/classify-reply/README.md): a return date only on an out-of-office
// answer. callAgent retries a failure once, then records ai_failed. Pure.
import type { GateResult } from "@whytide/ai";
import type { ClassifyReplyOutput } from "../../schemas/classify.ts";

export function returnDateGate(output: ClassifyReplyOutput): GateResult {
  const misplaced = output.returnDate !== null && output.label !== "out_of_office";
  const issue = { path: "returnDate", message: "a return date only with out_of_office" };
  return { gate: "return_date", issues: misplaced ? [issue] : [] };
}
