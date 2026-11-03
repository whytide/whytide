// The profile read of a signal run (README.md "Worker"; workflows/index.ts linkedin_read_profile,
// alpha-p8-030), the engager read's twin: the profile's URL comes in a request file and the profile
// goes out in a file, both under the workspace's raw/, so that no workflow input, result or history
// holds either. Business fields only, as the port parses them (docs/security.md).
import { linkedinProfile } from "@whytide/providers";
import { z } from "zod";

/** The activity's input, which workflows/index.ts parses: ids and the two files' keys. */
export type ReadProfile = {
  readonly workspaceId: string;
  readonly accountId: string;
  /** The request file the caller wrote, `{ profileUrl }`, under raw/. */
  readonly requestKey: string;
  /** Where the profile goes, under the workspace's folder and in raw/ (72 hours at most). */
  readonly rawKey: string;
};
/** The profile read: its file's whole key. */
export type ProfileRead = { readonly key: string };
/**
 * No profile, and no retry: the account is not connected, the profile is gone or out of sight, or
 * the provider failed on it until attempt PROFILE_READ_ATTEMPTS (workflows/constants.ts); or, before
 * the call, a kill switch holds, or the account is paused or held by its retry_at.
 */
export type ProfileRefused = {
  readonly refused:
    | "linkedin_account_disconnected"
    | "linkedin_not_found"
    | "linkedin_provider_error"
    | "account_paused"
    | "linkedin_rate_limited"
    | "platform_stopped"
    | "workspace_stopped"
    | "account_stopped";
};

/** The request file: the profile to read. */
export const profileRequestFile = z.strictObject({ profileUrl: linkedinProfile.shape.profileUrl });
/** The profile file: the port's profile as it answered it, `fetchedAt` in ISO. */
export const profileFile = z.strictObject({
  ...linkedinProfile.shape,
  fetchedAt: z.iso.datetime(),
});
export type ProfileFile = z.output<typeof profileFile>;
