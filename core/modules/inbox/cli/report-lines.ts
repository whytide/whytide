// The report's lines (README.md "The report"), pure: each `<code>: <detail>` with ids, ISO weeks,
// counts and shares only, never a text or a name, in the order LINE lists.
import { TARGETS } from "../domain/report/constants.ts";
import type { Figures } from "../domain/report/figures.ts";
import { LINE, NO_SHARE, SHARE_DECIMALS, TOO_FEW } from "./constants.ts";

/** The figures' lines. */
export function reportLines({ replyRateLinkedin, positive, agreement }: Figures): string[] {
  const { touched, replied } = replyRateLinkedin;
  const lines = [
    `${LINE.replyRateLinkedin}: ${shown(replyRateLinkedin.share)} touched=${touched} replied=${replied} target=${TARGETS.replyLinkedin}`,
  ];
  for (const { workspaceId, week, positives } of positive.weeks) {
    lines.push(`${LINE.positiveWeek}: ${workspaceId} ${week} ${positives}`);
  }
  const total = positive.weeks.reduce((sum, { positives }) => sum + positives, 0);
  lines.push(
    `${LINE.positiveConversations}: ${shown(positive.mean)} workspace_weeks=${positive.weeks.length} positives=${total} target=${TARGETS.positiveConversations}`,
  );
  lines.push(
    agreement.tooFew
      ? `${LINE.classifierAgreement}: ${TOO_FEW} pairs=${agreement.pairs}`
      : `${LINE.classifierAgreement}: f1_interested=${shown(agreement.f1Interested)} opt_out_share=${shown(agreement.optOutShare)} pairs=${agreement.pairs} target_f1=${TARGETS.f1Interested} target_opt_out=${TARGETS.optOutShare}`,
  );
  return lines;
}

/** A share to SHARE_DECIMALS decimals, or NO_SHARE. */
const shown = (value: number | null): string =>
  value === null ? NO_SHARE : value.toFixed(SHARE_DECIMALS);
