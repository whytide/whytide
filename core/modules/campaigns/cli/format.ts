// How the report's lines write a share (README.md "Commands"): fixed decimals, or what one reads when
// nothing was counted.
import { NO_SHARE, SHARE_DECIMALS } from "./constants.ts";

/** The share with SHARE_DECIMALS decimals; NO_SHARE for null. */
export const share = (value: number | null): string =>
  value === null ? NO_SHARE : value.toFixed(SHARE_DECIMALS);
