// An input of the read quota or the action log as its schema reads it (schemas/quota.ts), else
// read_input_invalid naming the fields at fault: these functions are called by code, not people.
import { AppError } from "@whytide/platform";
import type { z } from "zod";
import { errors } from "../errors.ts";

export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map(({ path }) => path.join(".")))];
  throw new AppError(errors.read_input_invalid, { details: { fields } });
}
