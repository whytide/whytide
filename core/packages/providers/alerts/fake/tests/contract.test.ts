// The fake's contract suite (../../../README.md "The contract suite"): its memory is the channel.
import { contractSuite } from "../../../testing/index.ts";
import { alertsCases } from "../../contract.ts";
import { alertsPort } from "../../port.ts";
import { alertsFake, alertsFakeAdapter } from "../index.ts";
import { fakeChannel } from "./channel.ts";

contractSuite(alertsPort, alertsFakeAdapter, alertsCases(fakeChannel(alertsFake)));
