// onboarding's `home` slot (ui/nav.ts; README "The prompt at sign-in"), a server component on the
// workspace home: the prompt to build Company Knowledge from the website, for a member whose role
// may write it (GET /v1/me), while the record has no content field and no draft waiting for review;
// else nothing. Both read as the member when the page loads. A failed read shows nothing, as the
// header's slots: the home never fails for the prompt, and the api has logged the failure.
import { serverApi } from "@whytide/web/api/server";
import { COMPANY_KNOWLEDGE_WRITE_ROLES } from "../../domain/constants.ts";
import { GetStarted } from "./get-started.tsx";
import { hasContent } from "./progress.ts";

const PATH = "/v1/workspaces/{workspaceId}/onboarding/company-knowledge";

export default async function GetStartedSlot({ workspaceId }: { workspaceId: string }) {
  const api = await serverApi();
  const { data: me } = await api.GET("/v1/me");
  const role = me?.memberships.find((membership) => membership.workspaceId === workspaceId)?.role;
  if (!COMPANY_KNOWLEDGE_WRITE_ROLES.some((writer) => writer === role)) return null;
  const { data: record } = await api.GET(PATH, { params: { path: { workspaceId } } });
  if (record === undefined || hasContent(record) || record.pendingDraft !== null) return null;
  return <GetStarted workspace={workspaceId} initial={record} />;
}
