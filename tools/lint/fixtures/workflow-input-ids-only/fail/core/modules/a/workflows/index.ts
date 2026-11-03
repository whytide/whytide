import { workflowInput } from "@whytide/platform";
import { z } from "zod";

export const inviteInput = z.object({ workspaceId: z.string(), email: z.string() });
export const greetInput = z.strictObject({ workspaceId: z.string(), full_name: z.string() });
export const noteInput = workflowInput.extend({ note_text: z.string() });
