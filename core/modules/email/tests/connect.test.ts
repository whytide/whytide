// The connect flow's pure parts (docs/flows.md "Connect"): the state's form and its expiry, the PKCE
// verifier derived from the state and its challenge, the address lowercased and the free consumer
// domains, the time zone. No database: the verifier needs only the test's master key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMasterKeys, newMasterKey } from "@whytide/platform";
import { codeChallengeFor } from "@whytide/providers";
import {
  addressOf,
  expiryOf,
  parseState,
  parseTimeZone,
  stateHashOf,
  verifierOf,
} from "../domain/connect.ts";
import { CONNECT_STATE_TTL_MS, FREE_CONSUMER_DOMAINS } from "../domain/constants.ts";
import { useSecretKeys } from "../domain/provider.ts";

const NONCE = "A".repeat(42) + "g";
const STATE = `wsp_01JAB3K5ZQ7W9R2M4T6V8X0Y1C.${NONCE}`;

test("a state is `<workspaceId>.<nonce>`, the nonce 43 base64url characters; anything else parses to null", () => {
  assert.deepEqual(parseState(STATE), {
    workspaceId: "wsp_01JAB3K5ZQ7W9R2M4T6V8X0Y1C",
    nonce: NONCE,
  });
  assert.deepEqual(parseState(`wsp_e2e_email.${NONCE}`)?.workspaceId, "wsp_e2e_email");
  for (const bad of [
    "",
    NONCE,
    `.${NONCE}`,
    `wsp_a.${NONCE}x`,
    `wsp_a.${NONCE.slice(1)}`,
    `wsp a.${NONCE}`,
  ]) {
    assert.equal(parseState(bad), null, bad);
  }
  assert.match(stateHashOf(NONCE), /^[0-9a-f]{64}$/);
  assert.notEqual(stateHashOf(NONCE), stateHashOf(`${NONCE.slice(1)}B`));
});

test("a connect expires CONNECT_STATE_TTL_MS, 10 minutes, after it was made", () => {
  const at = new Date("2026-11-01T10:00:00Z");
  assert.equal(CONNECT_STATE_TTL_MS, 600_000);
  assert.deepEqual(expiryOf(at), new Date("2026-11-01T10:10:00Z"));
});

test("the verifier is derived from the state: 43 characters, the same for one state and key, another for another state or key, and its S256 challenge is the consent's", () => {
  const keys = loadMasterKeys({ APP_MASTER_KEY: newMasterKey() });
  useSecretKeys(keys);
  try {
    const verifier = verifierOf(STATE);
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(verifierOf(STATE), verifier);
    assert.notEqual(verifierOf(`wsp_other.${NONCE}`), verifier);
    assert.match(codeChallengeFor(verifier), /^[A-Za-z0-9_-]{43}$/);
    useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
    assert.notEqual(verifierOf(STATE), verifier, "a rotated master key fails the connect");
  } finally {
    useSecretKeys(undefined);
  }
});

test("the address is lowercased; a public provider's domain is a free consumer address", () => {
  assert.deepEqual(addressOf(" Ada.Lovelace@Example.COM "), {
    emailAddress: "ada.lovelace@example.com",
    domain: "example.com",
    isFreeConsumer: false,
  });
  for (const domain of [
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "yahoo.com",
    "icloud.com",
  ]) {
    assert.ok(FREE_CONSUMER_DOMAINS.includes(domain), domain);
    assert.equal(addressOf(`someone@${domain.toUpperCase()}`).isFreeConsumer, true, domain);
  }
  assert.equal(addressOf("someone@mail.gmail.com.example").isFreeConsumer, false);
});

test("a time zone Intl knows is kept as given; another is mailbox_time_zone_invalid", () => {
  assert.equal(parseTimeZone("Pacific/Auckland"), "Pacific/Auckland");
  assert.throws(() => parseTimeZone("Mars/Olympus_Mons"), { code: "mailbox_time_zone_invalid" });
});
