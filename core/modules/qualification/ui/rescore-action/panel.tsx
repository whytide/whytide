// qualification's panel in the actions slot of contacts' lead page (ui/nav.ts `panels`; README
// "Screen"), a server component: the lead read as the member, its status, its reason and its
// snapshot, which rescore-action.tsx shows in the browser with Re-score. A failed read is its error
// state, whose retry reads again.
import { ApiError, data, serverApi } from "@whytide/web/api/server";
import { RescoreAction } from "./rescore-action.tsx";

export default async function RescorePanel(props: { workspace: string; personId: string }) {
  const { workspace: workspaceId, personId } = props;
  const api = await serverApi();
  const path = { workspaceId, personId };
  try {
    const lead = await data(
      api.GET("/v1/workspaces/{workspaceId}/contacts/leads/{personId}", { params: { path } }),
    );
    const shown = {
      status: lead.qualificationStatus,
      reason: lead.statusReason,
      snapshotId: lead.currentScoreSnapshotId,
    };
    return <RescoreAction workspaceId={workspaceId} personId={personId} lead={shown} />;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "internal_error";
    return (
      <RescoreAction
        workspaceId={workspaceId}
        personId={personId}
        failure={{ module: "contacts", code }}
      />
    );
  }
}
