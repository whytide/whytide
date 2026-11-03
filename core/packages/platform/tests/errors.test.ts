// Unit tests of the error registry (alpha-p1-030): snake_case codes, HTTP statuses from the
// registry and the defaults, AppError and isAppError.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppError,
  defineErrors,
  httpStatus,
  isAppError,
  registeredErrors,
} from "../errors/index.ts";
import { throwsCode } from "../testing/index.ts";

test("codes map to HTTP statuses: the registry first, then the defaults", () => {
  const errors = defineErrors({
    icp_not_found: {},
    invite_required: {},
    draft_rejected: { status: 422 },
  });
  assert.equal(errors.icp_not_found, "icp_not_found");
  assert.equal(new AppError("insufficient_credits").status, 402);
  assert.equal(httpStatus("insufficient_credits"), 402);
  assert.equal(httpStatus(errors.icp_not_found), 404);
  assert.equal(httpStatus(errors.invite_required), 403);
  assert.equal(httpStatus(errors.draft_rejected), 422);
  assert.equal(httpStatus("invalid_id"), 400);
  assert.equal(httpStatus("unauthenticated"), 401);
  assert.equal(httpStatus("something_else"), 500);
  assert.equal(new AppError(errors.icp_not_found, { status: 410 }).status, 410);
  assert.equal(registeredErrors().get("draft_rejected")?.status, 422);
});

test("a code is snake_case: a space, a capital letter or a sentence is rejected at registration", () => {
  throwsCode(() => defineErrors({ "not found": {} }), "invalid_error_code");
  throwsCode(() => defineErrors({ icpNotFound: {} }), "invalid_error_code");
  throwsCode(() => defineErrors({ "The ICP was not found.": {} }), "invalid_error_code");
  throwsCode(() => new AppError("Not Found"), "invalid_error_code");
  throwsCode(() => defineErrors({ icp_not_found: { status: 410 } }), "duplicate_error_code");
});

test("AppError carries the code as its message, details and a cause", () => {
  const cause = new Error("boom");
  const error = new AppError("icp_not_found", { details: { icp_id: "icp_x" }, cause });
  assert.equal(error.message, "icp_not_found");
  assert.equal(error.name, "AppError");
  assert.equal(error.cause, cause);
  assert.deepEqual(error.details, { icp_id: "icp_x" });
  assert.ok(isAppError(error));
  assert.ok(!isAppError(cause));
  assert.ok(!isAppError(null));
});
