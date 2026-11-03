// The switches' states (docs/concepts.md "Kill switches"; docs/data.md): what a missing row reads as,
// each stop's columns in each of its states, and the states' names in the control events.
import type { SwitchSource } from "../accounts.ts";

/** A workspace's or an account's stop: off, or on and held by its source, as the events name it. */
export type StopState = "off" | SwitchSource;

/** No platform row, a fresh instance: sending closed, nothing stopped, invites not paused. */
export const NO_PLATFORM_ROW = Object.freeze({
  sendingOpen: false,
  stopped: false,
  invitesPaused: false,
});

/** No row for the workspace: not stopped. */
export const NO_WORKSPACE_ROW = Object.freeze({ stopped: false, stopSource: null });

/** The account's columns in each state of its stop: the source is set exactly while it is on. */
export const ACCOUNT_STOP = Object.freeze({
  off: { killSwitch: false, killSwitchSource: null },
  tester: { killSwitch: true, killSwitchSource: "tester" },
  operator: { killSwitch: true, killSwitchSource: "operator" },
} as const);

/** The workspace's columns in each state of its stop, as the account's. */
export const WORKSPACE_STOP = Object.freeze({
  off: { stopped: false, stopSource: null },
  tester: { stopped: true, stopSource: "tester" },
  operator: { stopped: true, stopSource: "operator" },
} as const);

/** The platform's switches' states as the events name them, off then on; `invites`, the breaker's pause. */
export const PLATFORM_STATES = Object.freeze({
  sending: ["closed", "open"],
  stop: ["off", "on"],
  invites: ["off", "on"],
} as const);
