import { workflowInput } from "@whytide/platform";
import { z } from "zod";

export const runInput = workflowInput.extend({ runId: z.string(), personIds: z.array(z.string()) });
export const batchInput = z.object({ workspaceId: z.string(), batchSize: z.number() });
