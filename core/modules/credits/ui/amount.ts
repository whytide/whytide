// How the credits screens show an amount, a decimal string from the api: in the reader's locale, to
// four decimals at most, so that a lead's few hundredths of a credit still show.
export const AMOUNT = { maximumFractionDigits: 4 } as const;
