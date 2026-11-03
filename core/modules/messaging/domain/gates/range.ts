// The characters a written message aims for (README.md "The writer"): outside them, the length gate
// asks the writer again (index.ts), and the draft panel's counter says them. It imports nothing, so
// that the browser's bundle takes this file alone.
export const MESSAGE_RANGE = { min: 150, max: 300 } as const;
