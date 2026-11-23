// The erasure's values (docs/flows.md "Erase").

/** How long one erasure's tenant run may take before Prisma ends it, which rolls every row back. */
export const ERASE_TIMEOUT_MS = 120_000;
