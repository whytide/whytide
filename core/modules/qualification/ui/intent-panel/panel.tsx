// qualification's panel in the evidence slot of contacts' lead page (ui/nav.ts `panels`; README
// "Screen"), a server component: the lead's snapshot read as the member through the web's API
// client, the audience it was judged against (audience-note.tsx, gamma-p5-050) and its intent,
// which intent-view.tsx shows with the snapshot's fit. A lead without a snapshot shows nothing, one
// without an intent row its audience alone; a failed read is the slot's error state, whose retry
// reads again.
import { ApiError, data, serverApi } from "@whytide/web/api/server";
import { AudienceNote } from "./audience-note.tsx";
import { NOT_FOUND } from "./constants.ts";
import { IntentView } from "./intent-view.tsx";

export default async function IntentPanel(props: { workspace: string; personId: string }) {
  const path = { workspaceId: props.workspace, personId: props.personId };
  const api = await serverApi();
  const read = api.GET("/v1/workspaces/{workspaceId}/qualification/leads/{personId}/snapshot", {
    params: { path },
  });
  const snapshot = await data(read).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === NOT_FOUND) return null;
    throw error;
  });
  if (snapshot === null) return null;
  return (
    <>
      {snapshot.audience && <AudienceNote audience={snapshot.audience} />}
      {snapshot.intent && <IntentView intent={snapshot.intent} fit={snapshot.fitScore ?? 0} />}
    </>
  );
}
