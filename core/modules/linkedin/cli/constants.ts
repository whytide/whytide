// The fixed values of `pnpm linkedin:control` (README.md "The control command", docs/runbook.md).

/** The exit codes: done, an unchanged state included; refused; a usage error. Through pnpm, any failure is 1. */
export const EXIT = { done: 0, refused: 1, usage: 2 } as const;

/**
 * The operator's name, which every control event records as its `actor`: a name, never free text,
 * since the events hold ids and codes only.
 */
export const OPERATOR_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The usage line of each subcommand; an unknown subcommand prints them all, in this order. */
export const USAGE = Object.freeze({
  sending: "usage: pnpm linkedin:control sending <open | close> --operator <name>",
  stop: "usage: pnpm linkedin:control stop --platform --operator <name>",
  start: "usage: pnpm linkedin:control start --platform --operator <name>",
  breaker: "usage: pnpm linkedin:control breaker reopen --operator <name>",
  pause:
    "usage: pnpm linkedin:control pause --workspace <id or slug> [--account <sac_id>] --operator <name>",
  unpause:
    "usage: pnpm linkedin:control unpause --workspace <id or slug> [--account <sac_id>] --operator <name>",
  status: "usage: pnpm linkedin:control status [--workspace <id or slug>]",
});
