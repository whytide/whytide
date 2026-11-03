// The validation pipe (docs/request-path.md): NestJS's own Standard Schema pipe, global, over the
// schema a handler gives its @Body, @Param or @Query (`@Body({ schema })`), Zod here. An input off it
// is 400 validation_failed with the paths of the fields at fault, never the schema's sentences.
import { StandardSchemaValidationPipe } from "@nestjs/common";
import { AppError } from "@whytide/platform";
import { hostErrors } from "./errors.ts";

type Segment = PropertyKey | { readonly key: PropertyKey };

/** `items.0.qty` for each issue, once each; the empty path is the input itself. */
export function fieldPaths(issues: readonly { readonly path?: readonly Segment[] }[]): string[] {
  const path = (segments: readonly Segment[] = []) =>
    segments.map((s) => String(typeof s === "object" ? s.key : s)).join(".");
  return [...new Set(issues.map((issue) => path(issue.path)))];
}

export function validationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      new AppError(hostErrors.validation_failed, { details: { fields: fieldPaths(issues) } }),
  });
}
