// The engager read of a signal run (README.md "Worker"; workflows/index.ts
// linkedin_read_post_engagers, alpha-p8-020): its input, its answers and the page file it writes for
// the reader's module, business fields only, as the port parses them (docs/security.md). The cursor is
// the vendor's and unsigned: it stays in the workflow, never in a request.
import { linkedinEngager } from "@whytide/providers";
import { z } from "zod";

/** The activity's input, which workflows/index.ts parses: ids, the post, the page, and its file. */
export type ReadPostEngagers = {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly postUrl: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
  /** Under the workspace's folder and in raw/, so the files port's 72-hour lifecycle applies. */
  readonly rawKey: string;
};
/** A page read: its file's whole key, its engagers' count and the cursor of the next, or null. */
export type EngagersPage = {
  readonly key: string;
  readonly count: number;
  readonly nextCursor: string | null;
};
/** No page, and no retry: the account is not connected, or the post is gone or out of its sight. */
export type EngagersRefused = {
  readonly refused: "linkedin_account_disconnected" | "linkedin_not_found";
};

/** The page file: the port's engagers as it answered them, newest first, `engagedAt` in ISO. */
export const engagersFile = z.strictObject({
  engagers: z.array(z.strictObject({ ...linkedinEngager.shape, engagedAt: z.iso.datetime() })),
});
export type EngagersFile = z.output<typeof engagersFile>;
