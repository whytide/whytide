// The workspace a command's --workspace names (README.md "The reply golden set", "The report"): by
// id, which has an underscore, else by slug, through tenancy's index.
import { isAppError } from "@whytide/platform";
import { findWorkspace, findWorkspaceBySlug, errors as tenancyErrors } from "@whytide/tenancy";
import { ID_MARK } from "./constants.ts";

/**
 * The workspace named, as a list of its id; null for none, a value that is neither, or a slug two
 * organizations share.
 */
export async function workspaceNamed(named: string): Promise<string[] | null> {
  try {
    const workspace = named.includes(ID_MARK)
      ? await findWorkspace(named)
      : await findWorkspaceBySlug(named);
    return workspace === null ? null : [workspace.id];
  } catch (error) {
    if (isAppError(error) && error.code === tenancyErrors.tenancy_input_invalid) return null;
    throw error;
  }
}
