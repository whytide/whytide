// The codes of `pnpm openapi:build`, the .http runner and `pnpm session:token` (README "OpenAPI and the
// client", "The .http file"): developer-facing, never an HTTP answer, so no message keys and no status.
import { defineErrors } from "@whytide/platform";

export const openapiErrors = defineErrors({
  /** Mounted routes without @ApiRoute: `details.routes`, `GET /v1/…` each. */
  openapi_route_undocumented: {},
  /** An @ApiRoute or @ApiHeader off its shape, or a path or method the document cannot say. */
  openapi_route_invalid: {},
  /** A schema JSON Schema cannot say (a date, a transform's output) or one with an id or a cycle. */
  openapi_schema_unsupported: {},
  /** A cookie or authorization parameter, or an example value under such a name. */
  openapi_secret_example: {},
  /** The validator's problems: `details.problems`, each with its rule and JSON pointer. */
  openapi_document_invalid: {},
  /** Routes no request of a .http file calls: `details.routes`. */
  openapi_route_without_request: {},
  /** A .http file the parser cannot read: `details.file`, `details.line`, `details.expected`. */
  http_file_invalid: {},
  /** A {{variable}} the environment files do not set: `details.variable`. */
  http_variable_missing: {},
  /** A base URL off the loopback: the runner and session:token reach the laptop's api only. */
  http_target_refused: {},
  /** The api refused the sign-in: `details.status` and `details.code`, the api's. */
  session_token_refused: {},
});
