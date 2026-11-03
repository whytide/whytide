// The review panel in the lead page's review slot (ui/nav.ts `panels`; README.md "Screens"): the
// lead's decisions, newest first, read as the member when the page loads; form.tsx, in the browser,
// decides and keeps the history.
import { data, serverApi } from "@whytide/web/api/server";
import type { PanelProps } from "../lead/slots.ts";
import { ReviewForm } from "./form.tsx";

type Api = Awaited<ReturnType<typeof serverApi>>;
type Path = { workspaceId: string; personId: string };

const readReviews = (api: Api, path: Path) =>
  api.GET("/v1/workspaces/{workspaceId}/contacts/leads/{personId}/reviews", { params: { path } });
export type Review = NonNullable<
  Awaited<ReturnType<typeof readReviews>>["data"]
>["reviews"][number];

export default async function ReviewPanel({ workspace, personId }: PanelProps) {
  const api = await serverApi();
  const { reviews } = await data(readReviews(api, { workspaceId: workspace, personId }));
  return <ReviewForm workspace={workspace} personId={personId} history={reviews} />;
}
