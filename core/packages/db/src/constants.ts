// The constants of `node src/cli.ts generate` (src/generate.ts).

/** The lock folder, beside generated/: Prisma refuses a generated/ with files but no client.ts. */
export const GENERATE_LOCK = "generated.lock";
/** The stamp in generated/, the hash of the client's inputs: not a kind of file Prisma deletes. */
export const GENERATE_STAMP = "inputs.sha256";
/** How long a generate waits for another one's lock before it stops, naming the lock. */
export const GENERATE_WAIT_MS = 120_000;
/** How often a waiting generate looks at the lock again. */
export const GENERATE_POLL_MS = 100;
