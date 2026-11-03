// The unit test of the error filter's mapping (alpha-p2-010): an AppError answers its code's status
// with { code, details }, details below 500 only; NestJS's and the body parser's HTTP errors keep
// their status under a code of ours; anything else is 500 internal_error. Never a message or a stack.
import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AppError } from "@whytide/platform";
import { toErrorResponse } from "../src/error-filter.ts";

test("an AppError answers its code's status, with its details below 500 only", () => {
  const details = { fields: ["name"] };
  assert.deepEqual(toErrorResponse(new AppError("validation_failed", { details })), {
    status: 400,
    body: { code: "validation_failed", details },
  });
  assert.deepEqual(toErrorResponse(new AppError("forbidden")), {
    status: 403,
    body: { code: "forbidden" },
  });
  assert.deepEqual(toErrorResponse(new AppError("lead_not_found")), {
    status: 404,
    body: { code: "lead_not_found" },
  });
  assert.deepEqual(
    toErrorResponse(new AppError("unknown_action", { details: { action: "a.b" } })),
    {
      status: 500,
      body: { code: "unknown_action" },
    },
  );
});

test("an HTTP error keeps its status under a code of ours; anything else is internal_error", () => {
  const tooLarge = Object.assign(new Error("request entity too large"), {
    status: 413,
    expose: true,
  });
  const cases: [unknown, number, string][] = [
    [new NotFoundException("Cannot GET /x?token=y"), 404, "not_found"],
    [new BadRequestException("Unexpected token in JSON"), 400, "invalid_request"],
    [tooLarge, 413, "payload_too_large"],
    [Object.assign(new Error("boom"), { status: 418 }), 500, "internal_error"],
    [new TypeError("x is undefined"), 500, "internal_error"],
    ["a string", 500, "internal_error"],
  ];
  for (const [error, status, code] of cases) {
    assert.deepEqual(toErrorResponse(error), { status, body: { code } });
  }
});
