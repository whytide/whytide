// The gates' aggregation (README.md "Gates"): every gate runs; the issues of the failed ones come back
// as one failed validation, reason `gates`, each issue named by its gate; nothing when all pass.
import assert from "node:assert/strict";
import { it } from "node:test";
import type { z } from "zod";
import { checkGates } from "../call/gates.ts";
import type { AgentGate } from "../registry/define.ts";

type Gate = AgentGate<z.ZodObject, z.ZodObject>;
const passes: Gate = () => ({ gate: "length", issues: [] });
const grounding: Gate = (output, input) => ({
  gate: "grounding",
  issues: String(output.text)
    .split(/[^A-Za-z]+/)
    .filter((word) => /^[A-Z]/.test(word) && !String(input.facts).includes(word))
    .map((word) => ({ path: "text", message: `${word} is not in the facts` })),
});
const redLines: Gate = (output) => ({
  gate: "red_lines",
  issues: String(output.text).includes("as we discussed")
    ? [{ path: "text", message: "false familiarity" }]
    : [],
});
const gates = [passes, grounding, redLines];

it("returns nothing when every gate passes, or when the task has none", () => {
  const input = { facts: "Acme hires" };
  assert.equal(checkGates(gates, { text: "Acme is hiring" }, input), undefined);
  assert.equal(checkGates([], { text: "Initech as we discussed" }, input), undefined);
});

it("runs every gate and returns the failed ones' issues, in order, named by their gate", () => {
  const output = { text: "Initech and Globex, as we discussed" };
  assert.deepEqual(checkGates(gates, output, { facts: "Acme hires" }), {
    reason: "gates",
    issues: [
      { gate: "grounding", path: "text", message: "Initech is not in the facts" },
      { gate: "grounding", path: "text", message: "Globex is not in the facts" },
      { gate: "red_lines", path: "text", message: "false familiarity" },
    ],
  });
});
