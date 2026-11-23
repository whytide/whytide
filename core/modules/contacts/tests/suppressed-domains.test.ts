// The never-contact list read by domains (gamma-wr-046; README.md "Public interface"; domain/suppression/
// domains.ts) on the worktree's database: a domain is held by a blocklist entry on it or on a parent of
// it, never by one on a subdomain or on a lookalike; a customer or a competitor entry names its kind,
// the block first when two hold a domain; an entry on one channel counts; a removed entry and an
// opt-out hold no domain; what is no domain is absent; one read of the entries whatever the number;
// another workspace's entries hold nothing here.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { SUPPRESSION_BATCH_SIZE } from "../domain/suppression/constants.ts";
import { suppressedDomains } from "../domain/suppression/domains.ts";
import { addSuppression, removeSuppression } from "../domain/suppression/entries.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const principal = servicePrincipal("contacts_test");
const USER = "usr_domains_tester";
const as =
  (workspaceId: string) =>
  <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const WORKSPACE = "wsp_contacts_domains";
const run = as(WORKSPACE);
const add = (input: Omit<Parameters<typeof addSuppression>[0], "createdBy">, to = run) =>
  to(() => addSuppression({ ...input, createdBy: USER }));

test("a domain is held by an entry on it or on a parent, not by one on a subdomain or a lookalike; a customer and a competitor name their kind, the block first; a channel entry counts; a removed one does not", async () => {
  await add({ kind: "company", value: "harbor.example" });
  await add({ kind: "company", value: "quay.example", relationship: "customer" });
  await add({ kind: "company", value: "dock.example", relationship: "competitor" });
  await add({ kind: "company", value: "dock.example" });
  await add({ kind: "company", value: "mail-only.example", channel: "email" });
  const { entry } = await add({ kind: "company", value: "lifted.example" });
  await run(() => removeSuppression(entry.id, { removedBy: USER }));
  await add({ kind: "company", value: "west.coast.example" });
  const asked = [
    ...["harbor.example", "https://www.harbor.example/about", "eu.harbor.example"],
    ...["quay.example", "dock.example", "mail-only.example", "lifted.example"],
    ...["notharbor.example", "coast.example", "west.coast.example", "not a domain", ""],
  ];
  const held = await run(() => suppressedDomains(asked));
  assert.deepEqual(Object.fromEntries(held), {
    "harbor.example": "never_contact",
    "https://www.harbor.example/about": "never_contact",
    "eu.harbor.example": "never_contact",
    "quay.example": "customer",
    "dock.example": "never_contact",
    "mail-only.example": "never_contact",
    "west.coast.example": "never_contact",
  });
});

test("another workspace's entries hold nothing; an empty list and a list past the batch are answered by the rules", async () => {
  await add({ kind: "company", value: "elsewhere.example" }, as("wsp_contacts_domains_b"));
  assert.equal((await run(() => suppressedDomains(["elsewhere.example"]))).size, 0);
  assert.equal((await run(() => suppressedDomains([]))).size, 0);
  const many = Array.from({ length: SUPPRESSION_BATCH_SIZE + 1 }, (_, at) => `d${at}.example`);
  await assert.rejects(() => run(() => suppressedDomains(many)), {
    code: "contacts_input_invalid",
  });
});
