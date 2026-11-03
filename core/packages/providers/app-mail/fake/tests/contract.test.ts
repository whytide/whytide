// The fake's contract suite (README.md "The contract suite"): its memory is the mailbox it delivers to.
import { contractSuite } from "../../../testing/index.ts";
import { appMailCases } from "../../contract.ts";
import { appMailPort } from "../../port.ts";
import { appMailFake, appMailFakeAdapter } from "../index.ts";

contractSuite(appMailPort, appMailFakeAdapter, appMailCases(appMailFake.read));
