import { ids } from "@whytide/platform";
import { z } from "zod";
export const score = z.object({ id: z.string() }).parse(ids);
