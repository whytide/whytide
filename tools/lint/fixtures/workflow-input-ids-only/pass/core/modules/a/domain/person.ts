import { z } from "zod";

// Outside workflows/, a schema may hold personal data: it never reaches Temporal's history.
export const person = z.object({ email: z.string(), name: z.string() });
