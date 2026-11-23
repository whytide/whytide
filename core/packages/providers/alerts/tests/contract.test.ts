// The port's own tests, and the task's suite on the fake (README.md "The contract suite"): the
// registry loads the fake's folder by its name, the value PROVIDER_ALERTS takes, and the contract
// suite runs on it; an empty PROVIDER_ALERTS binds nothing (provider_not_configured), so the caller
// has no adapter to send through; the codes are registered with their statuses. PROVIDER_ALERTS is
// emptied before the config is imported, which reads it once.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterDefinition } from "../../_pattern/index.ts";
import type { AlertsFake } from "../port.ts";

process.env.PROVIDER_ALERTS = "";
const { httpStatus, isAppError } = await import("@whytide/platform");
const { isFake, registeredAdapters } = await import("../../_pattern/index.ts");
const { getAdapter } = await import("../../registry.ts");
const { contractSuite } = await import("../../testing/index.ts");
const { alertsCases } = await import("../contract.ts");
const { fakeChannel } = await import("../fake/tests/channel.ts");
const { alertsConfig, alertsPort } = await import("../port.ts");

const alerts = await getAdapter(alertsPort, "fake");
const fake = registeredAdapters(alertsPort).get("fake");
assert.ok(fake, "the registry loaded the fake");
contractSuite(
  alertsPort,
  fake as AdapterDefinition<typeof alertsPort>,
  alertsCases(fakeChannel(alerts as unknown as AlertsFake)),
);

test("an empty PROVIDER_ALERTS binds no adapter: no team channel, nothing to send through", async () => {
  assert.equal(alertsConfig.PROVIDER_ALERTS, undefined);
  await assert.rejects(getAdapter(alertsPort, alertsConfig.PROVIDER_ALERTS), (error: unknown) => {
    assert.ok(isAppError(error) && error.code === "provider_not_configured");
    assert.deepEqual(error.details, { port: "alerts", variable: "PROVIDER_ALERTS" });
    return true;
  });
  assert.ok(isFake(alerts), "the name `fake` gives the fake, its controls reachable");
  assert.equal(await getAdapter(alertsPort, "fake"), alerts, "one bound instance per process");
});

test("the codes, with their statuses: the port's three and the pattern's", () => {
  const statuses = Object.fromEntries(
    [
      "alerts_rejected",
      "alerts_rate_limited",
      "alerts_unreachable",
      "alerts_input_invalid",
      "alerts_output_invalid",
      "alerts_error_unmapped",
    ].map((code) => [code, httpStatus(code)]),
  );
  assert.deepEqual(statuses, {
    alerts_rejected: 502,
    alerts_rate_limited: 429,
    alerts_unreachable: 503,
    alerts_input_invalid: 400,
    alerts_output_invalid: 500,
    alerts_error_unmapped: 500,
  });
  assert.deepEqual(Object.keys(alertsPort.methods), ["send"]);
});
