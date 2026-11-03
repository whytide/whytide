// The drawings of the brand, as data: the logo mark's waves and signal (a 24 by 24 box), and the
// tide under the sign-in pages' panel (a 1200 by 400 box, stretched to its width).
export const MARK_BOX = "0 0 24 24";
export const MARK_WAVES = [
  "M4 12.5c1.6 0 2.4-1.5 4-1.5s2.4 1.5 4 1.5 2.4-1.5 4-1.5 2.4 1.5 4 1.5",
  "M4 17c1.6 0 2.4-1.5 4-1.5s2.4 1.5 4 1.5 2.4-1.5 4-1.5 2.4 1.5 4 1.5",
] as const;
export const MARK_SIGNAL = { cx: 16.5, cy: 6.75, r: 1.75 } as const;

export const TIDE_BOX = "0 0 1200 400";
/** Three swells, back to front, each filled to the bottom edge, and the crest line over the first. */
export const TIDE_SWELLS = [
  { d: "M0 250C200 190 400 310 600 250S1000 190 1200 250V400H0Z", opacity: 0.07 },
  { d: "M0 295C220 240 380 350 620 290S1010 245 1200 300V400H0Z", opacity: 0.1 },
  { d: "M0 340C180 300 420 385 640 335S1020 300 1200 345V400H0Z", opacity: 0.15 },
] as const;
export const TIDE_CREST = "M0 250C200 190 400 310 600 250S1000 190 1200 250";
