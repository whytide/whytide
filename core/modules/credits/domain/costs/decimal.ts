// Exact decimals for the cost counter (README "Decided here") and the credit alerts' share: amounts
// arrive as Postgres numeric's strings, and a float adds 0.2 ten times to 1.9999999999999998.
// Integers on BigInt at the 30 fractional digits of numeric(65, 30), the columns' scale; amounts are
// never negative (CHECKs).

const SCALE = 30;
const ONE = 10n ** BigInt(SCALE);

const units = (value: string): bigint => {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * ONE + BigInt(fraction.padEnd(SCALE, "0").slice(0, SCALE));
};

const text = (value: bigint): string => {
  const fraction = (value % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return fraction === "" ? `${value / ONE}` : `${value / ONE}.${fraction}`;
};

/** The sum of decimal strings, exactly; "0" for none. */
export function sum(values: readonly string[]): string {
  return text(values.reduce((total, value) => total + units(value), 0n));
}

/** `value × times ÷ over`, cut at the 30th decimal; `over` is a positive integer. */
export function share(value: string, times: number, over: number): string {
  return text((units(value) * BigInt(times)) / BigInt(over));
}

/** `value × 100 ÷ over`, in percent, cut at the 30th decimal; null when `over` is 0. */
export function percentOf(value: string, over: string): string | null {
  const base = units(over);
  return base === 0n ? null : text((units(value) * 100n * ONE) / base);
}
