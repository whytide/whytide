// The alerts port's contract (README.md "The contract suite"): what every adapter does, run by each
// adapter's tests/contract.test.ts with the team channel it posts to, the fake's memory or a local
// server: a text sent as given; an empty, too long or control-character text refused before any
// call; each of the port's codes from the channel's answer.
import assert from "node:assert/strict";
import { isAppError } from "@whytide/platform";
import type { ContractCases } from "../testing/index.ts";
import { ALERT_TEXT_MAX } from "./constants.ts";
import type { alertsPort } from "./port.ts";

/** The port's codes a channel's answer maps to. */
export type AlertsFailure = "alerts_rejected" | "alerts_rate_limited" | "alerts_unreachable";

/** The team channel an adapter posts to, as a case sees it. */
export type AlertsChannel = {
  /** Every text that reached the channel, in order. */
  readonly received: () => readonly string[];
  /** How many calls reached the channel, whatever it answered. */
  readonly calls: () => number;
  /** The channel's next answer is one the port reads as `code`; a rate limit asks for RETRY_AFTER_SEC. */
  readonly failNext: (code: AlertsFailure) => void;
};

/** The seconds the contract's rate limit asks to wait. */
export const RETRY_AFTER_SEC = 30;

const TEXT = "[test] activity linkedin.sendInvite linkedin_rate_limited ×3";
const withCode =
  (code: string, details?: Record<string, unknown>) =>
  (error: unknown): boolean => {
    if (!isAppError(error) || error.code !== code) return false;
    const given = (error.details ?? {}) as Record<string, unknown>;
    return Object.entries(details ?? {}).every(([key, value]) => given[key] === value);
  };

export function alertsCases(channel: AlertsChannel): ContractCases<typeof alertsPort> {
  /** What one send made the channel receive; the send answers {}. */
  const sentBy = async (send: () => Promise<unknown>) => {
    const before = channel.received().length;
    assert.deepEqual(await send(), {});
    return channel.received().slice(before);
  };
  return {
    "sends one text as given, its newlines and any script kept, and answers {}": async (alerts) => {
      const text = `${TEXT}\nws_01JAB3K5ZQ7W9R2M4T6V8X0Y1C · 送信を停止しました · «ok» ✓`;
      assert.deepEqual(await sentBy(() => alerts.send({ text })), [text]);
    },
    "sends a text of ALERT_TEXT_MAX characters whole": async (alerts) => {
      const text = "x".repeat(ALERT_TEXT_MAX);
      assert.deepEqual(await sentBy(() => alerts.send({ text })), [text]);
    },
    "refuses an empty text, a longer one, a control character but the newline and a key the port lacks, before any call: alerts_input_invalid":
      async (alerts) => {
        const calls = channel.calls();
        const refused = [
          { text: "" },
          { text: "x".repeat(ALERT_TEXT_MAX + 1) },
          ...["\t", "\r", "\u0000", "\u001b", "\u007f", "\u0085"].map((c) => ({ text: `a${c}b` })),
          // One team channel per instance: a call names no channel or address.
          { text: TEXT, channel: "#ops" },
        ];
        for (const input of refused) {
          const sending = alerts.send(input as { text: string });
          await assert.rejects(sending, withCode("alerts_input_invalid"), JSON.stringify(input));
        }
        assert.equal(channel.calls(), calls, "nothing reached the channel");
      },
    "a refusal is alerts_rejected": async (alerts) => {
      channel.failNext("alerts_rejected");
      await assert.rejects(alerts.send({ text: TEXT }), withCode("alerts_rejected"));
    },
    "a rate limit is alerts_rate_limited, with the seconds it asks to wait": async (alerts) => {
      channel.failNext("alerts_rate_limited");
      const limited = withCode("alerts_rate_limited", { retryAfterSec: RETRY_AFTER_SEC });
      await assert.rejects(alerts.send({ text: TEXT }), limited);
    },
    "no answer is alerts_unreachable, and the failure is the next call's only": async (alerts) => {
      channel.failNext("alerts_unreachable");
      await assert.rejects(alerts.send({ text: TEXT }), withCode("alerts_unreachable"));
      assert.deepEqual(await sentBy(() => alerts.send({ text: TEXT })), [TEXT]);
    },
  };
}
