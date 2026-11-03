// The tenant context of alpha-p1-045, the half without a database: currentTenant() inside and
// outside a run and in a timer the run left behind, two runs at once keeping their own workspace,
// the context checked on the way in, and withoutTenant(reason) leaving the workspace and logging its
// reason. The transaction and the client are core/packages/db's, tested end to end there
// (tests/tenant.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  checkLogLines,
  createLogger,
  currentTenant,
  currentTenantScope,
  insideTenantRun,
  isAppError,
  type Principal,
  servicePrincipal,
  withoutTenant,
  withTenantContext,
} from "../index.ts";
import { collectLogs, throwsCode } from "../testing/index.ts";

const worker = servicePrincipal("worker");
const member = (workspaceId: string): Principal => ({
  userId: "usr_01JAB3K5ZQ7W9R2M4T6V8X0Y1C",
  actorType: "human",
  authMethod: "session",
  membershipId: "mem_01JAB3K5ZQ7W9R2M4T6V8X0Y1D",
  workspaceId,
  role: "Owner",
  scopes: [],
});

test("currentTenant() is the run's context inside it, across awaits, and no_tenant_context outside", async () => {
  throwsCode(() => currentTenant(), "no_tenant_context");
  let late: Promise<unknown> | undefined;
  const seen = await withTenantContext({ workspaceId: "wsp_a", principal: worker }, async () => {
    await setImmediate();
    late = new Promise((resolve) => setTimeout(() => resolve(codeOf(currentTenant)), 5));
    return currentTenant();
  });
  assert.deepEqual(seen, { workspaceId: "wsp_a", principal: worker });
  assert.ok(Object.isFrozen(seen));
  throwsCode(() => currentTenant(), "no_tenant_context");
  assert.equal(currentTenantScope(), undefined);
  assert.equal(
    await late,
    "no_tenant_context",
    "a timer that fires after the run finds no context",
  );
});

test("two runs at once each see their own workspace", async () => {
  const run = (workspaceId: string) =>
    withTenantContext({ workspaceId, principal: worker }, async () => {
      const seen: string[] = [];
      for (let i = 0; i < 3; i++) {
        await setImmediate();
        seen.push(currentTenant().workspaceId);
      }
      return seen;
    });
  assert.deepEqual(await Promise.all([run("wsp_a"), run("wsp_b")]), [
    ["wsp_a", "wsp_a", "wsp_a"],
    ["wsp_b", "wsp_b", "wsp_b"],
  ]);
});

test("a context without a workspace or a user, or for another workspace's member, is refused", () => {
  const never = () => assert.fail("the run must not start");
  throwsCode(
    () => withTenantContext({ workspaceId: "", principal: worker }, never),
    "no_tenant_context",
  );
  throwsCode(
    () => withTenantContext({ workspaceId: "wsp_a", principal: { ...worker, userId: "" } }, never),
    "no_tenant_context",
  );
  assert.throws(
    () => withTenantContext({ workspaceId: "wsp_b", principal: member("wsp_a") }, never),
    (error) => isAppError(error) && error.code === "tenant_mismatch" && error.details === undefined,
    "the requested workspace, input from a URL, stays out of the error",
  );
  assert.equal(
    withTenantContext(
      { workspaceId: "wsp_a", principal: member("wsp_a") },
      () => currentTenant().workspaceId,
    ),
    "wsp_a",
  );
});

test("withoutTenant(reason) leaves the workspace and logs the reason, an identifier only", () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination });
  withTenantContext({ workspaceId: "wsp_a", principal: worker }, () =>
    withoutTenant(
      "tenancy",
      () => {
        throwsCode(() => currentTenant(), "no_tenant_context");
        assert.deepEqual(currentTenantScope(), { kind: "global", reason: "tenancy" });
        assert.equal(insideTenantRun(), true, "the run around it is still open");
      },
      { log },
    ),
  );
  assert.deepEqual(
    logs.lines().map(({ level, reason }) => ({ level, reason })),
    [{ level: "info", reason: "tenancy" }],
  );
  assert.equal(insideTenantRun(), false);
  assert.deepEqual(checkLogLines(logs.raw), []);
  for (const reason of ["", "Tenancy", "user a@example.com"]) {
    assert.throws(
      () => withoutTenant(reason, () => assert.fail("must not run"), { log }),
      (error) =>
        isAppError(error) && error.code === "invalid_tenant_reason" && error.status === 500,
    );
  }
  assert.equal(logs.lines().length, 1);
});

function codeOf(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    return isAppError(error) ? error.code : error;
  }
}
