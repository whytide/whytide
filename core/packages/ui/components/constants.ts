// The components' tunable values (README "Components"), beside the code that reads them.

/** Meter: the least share, in percent, a value above none takes, so that it shows. */
export const METER_LEAST_PERCENT = 1;
/** Meter: its SVG's box, a hundred wide so that a width is a percentage, one high. */
export const METER_BOX = "0 0 100 1";

/** NumberField: what Arrow Up and Arrow Down add or take away, unless the module gives a `step`. */
export const NUMBER_FIELD_STEP = 1;
/** NumberField: Page Up and Page Down move by this many steps. */
export const NUMBER_FIELD_PAGE_STEPS = 10;
/** NumberField: typed text that is a whole number: digits, a sign before them at most. */
export const WHOLE_NUMBER = /^[+-]?\d+$/;
