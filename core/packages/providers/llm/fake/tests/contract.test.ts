// The LLM port's suite on the fake (README.md "The contract suite"), the end-to-end test of
// alpha-p1-100: run by `pnpm -F providers test:contract`.
import { contractSuite } from "../../../testing/index.ts";
import { llmCases } from "../../contract.ts";
import { llmPort } from "../../port.ts";
import { llmFakeAdapter } from "../index.ts";

contractSuite(llmPort, llmFakeAdapter, llmCases);
