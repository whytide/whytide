// The webhook adapter's suite as a run without ALERTS_WEBHOOK_URL sees it (../contract.test.ts runs
// this file in a child): one skipped test. Its channel throws when touched, and every case touches
// it before it sends, so even a set variable would send nothing from here.
import { contractSuite } from "../../../../testing/index.ts";
import { alertsCases } from "../../../contract.ts";
import { alertsPort } from "../../../port.ts";
import { webhookAdapter } from "../../index.ts";

const untouched = (): never => {
  throw new Error("the suite was to be skipped: ALERTS_WEBHOOK_URL is set");
};
const channel = { received: untouched, calls: untouched, failNext: untouched };
contractSuite(alertsPort, webhookAdapter, alertsCases(channel));
