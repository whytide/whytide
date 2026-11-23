// Who owns an audience (README "Decided here"; gamma-p6-015), which the commands pass to platform's
// canWriteOwned and the screen compares with the signed-in member. Only constants.ts imported: the
// screen reads it too.
import { SYSTEM_CREATOR } from "./constants.ts";

/**
 * The audience's owner: the member whose request created it; null, the workspace's, for the
 * default, whoever's read created it, for a row made before gamma-p3-020 and for one a service made
 * (`system`). Only a holder of icp.manage writes a row owned by the workspace.
 */
export function audienceOwner(audience: {
  readonly isDefault: boolean;
  readonly createdBy: string | null;
}): string | null {
  if (audience.isDefault || audience.createdBy === SYSTEM_CREATOR) return null;
  return audience.createdBy;
}
