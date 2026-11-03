// The egress variables of the packages/platform block of deploy/.env.example, read once at import.
// The rules' (alpha-p1-060): the hosts the address and port rules let through, for local test
// servers, and the hosts never fetched. Both default to none, so importing @whytide/platform never
// throws; a malformed entry fails at start as config_invalid, naming the variable, never the value.
// The lists are frozen: defineConfig freezes only the object that holds them. The client's
// (alpha-p1-065): the bounds of a fetchSafe call that names none.
import { z } from "zod";
import { defineConfig, type Env } from "../config/define.ts";
import { isAppError } from "../errors/index.ts";
import { type HostEntry, parseHostList } from "./hosts.ts";

const hostList = () =>
  z
    .string()
    .default("")
    .transform((text, ctx): readonly HostEntry[] => {
      try {
        return parseHostList(text);
      } catch (error) {
        if (!isAppError(error)) throw error;
        ctx.addIssue({ code: "custom", message: "host or host:port entries separated by commas" });
        return z.NEVER;
      }
    });

/** The two variables from `env`: declared in this one place; a test reads them from its own env. */
export function readEgressConfig(env: Env = process.env) {
  return defineConfig(
    "packages/platform",
    {
      EGRESS_ALLOW_HOSTS: hostList(),
      EGRESS_DENY_HOSTS: hostList(),
    },
    env,
  );
}

export const egressConfig = readEgressConfig();

/** setTimeout's ceiling: a longer delay would fire at once. */
export const MAX_TIMEOUT_MS = 2_147_483_647;
/** The largest body the client holds in memory: 256 MiB. */
export const MAX_BODY_BYTES = 268_435_456;

/** The client's default bounds from `env`, in their own block call; a test reads its own env. */
export function readFetchSafeConfig(env: Env = process.env) {
  const bound = (max: number) => z.coerce.number().int().positive().max(max);
  return defineConfig(
    "packages/platform",
    {
      EGRESS_DEFAULT_TIMEOUT_MS: bound(MAX_TIMEOUT_MS).default(10_000),
      EGRESS_DEFAULT_MAX_BYTES: bound(MAX_BODY_BYTES).default(1_048_576),
    },
    env,
  );
}

export const fetchSafeConfig = readFetchSafeConfig();
