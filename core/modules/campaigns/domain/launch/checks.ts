// The launch checks (README.md "Launch checks"; RB-9.4.1, reduced), read live in the caller's
// tenant run with no cache, for the campaign's owner, since a member's campaigns send from that
// member's own accounts: linkedin's senderOf answers a connected account, not paused, whose health
// sends; that account's sending disclosure is accepted (linkedin's sendingDisclosureRequired false;
// with no account, none is); and the platform's credits balance covers the first step's price,
// compared as decimals. Every check is answered, the passing ones too, so the screen shows each.
import { type SenderAccount, senderOf, sendingDisclosureRequired } from "@whytide/linkedin";
import { credits, currentTenant } from "@whytide/platform";
import type { Campaign } from "../campaigns/reads.ts";
import {
  FIRST_STEP_PRICE,
  type LaunchCheck,
  type LaunchCheckCode,
  UNHEALTHY_SENDER_STATES,
} from "./constants.ts";

/** A check as the launch reads it: `code` null exactly when it passes. */
export type LaunchCheckResult = {
  readonly check: LaunchCheck;
  readonly ok: boolean;
  readonly code: LaunchCheckCode | null;
};

/** The checks of the campaign, read now, in LAUNCH_CHECKS' order. */
export async function checkLaunch(campaign: Campaign): Promise<LaunchCheckResult[]> {
  const { workspaceId } = currentTenant();
  const sender = await senderOf(campaign.ownerUserId);
  const balance = await credits.balance(workspaceId);
  const price = await credits.priceOf(FIRST_STEP_PRICE);
  const disclosed = sender !== null && !sendingDisclosureRequired(sender);
  return [
    result("linkedin_sender", senderCode(sender)),
    result("sending_disclosure", disclosed ? null : "disclosure_required"),
    result("credits", covers(balance.available, price.credits) ? null : "insufficient_credits"),
  ];
}

const result = (check: LaunchCheck, code: LaunchCheckCode | null): LaunchCheckResult => ({
  check,
  ok: code === null,
  code,
});

/** No connected account; one paused, by its owner or the operator, or whose health sends nothing. */
function senderCode(sender: SenderAccount | null): LaunchCheckCode | null {
  if (sender === null) return "no_linkedin_sender";
  const unhealthy = (UNHEALTHY_SENDER_STATES as readonly string[]).includes(sender.healthState);
  return sender.killSwitch || unhealthy ? "linkedin_sender_unhealthy" : null;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Whether the decimal string `available` is at least `price`, exactly, as credits writes both
 * (Postgres numeric as text); false for a value that is not a plain decimal, so it fails closed.
 */
export function covers(available: string, price: string): boolean {
  const [a, p] = [DECIMAL.exec(available), DECIMAL.exec(price)];
  if (a === null || p === null) return false;
  const scale = Math.max(a[3]?.length ?? 0, p[3]?.length ?? 0);
  const scaled = ([, sign, whole = "", fraction = ""]: RegExpExecArray) => {
    const digits = BigInt(whole + fraction.padEnd(scale, "0"));
    return sign === "-" ? -digits : digits;
  };
  return scaled(a) >= scaled(p);
}
