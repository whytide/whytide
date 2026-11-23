// The ICP screen, /w/{workspace}/icp (README "The screen"): a server component that reads the
// workspace's audiences with their limit, the one `?audience=<icpId>` names, else the default,
// through the ICP's own routes as before audiences, its criteria and its latest draft, through the
// api as the visitor, then hands them to the form, a client component. The first read of a
// workspace creates its default, as the api does; an id the workspace does not hold is the api's
// icp_not_found, which the screens' error boundary shows in words. Who is signed in (GET /v1/me)
// says whether the visitor may write the audience, its owner or a holder of icp.manage (README
// "Decided here"): else the form is read-only, with a hint.
import { data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { ICP_MANAGE_ROLES } from "../../domain/constants.ts";
import { audienceOwner } from "../../domain/owner.ts";
import { AUDIENCE_PARAM, AUDIENCE_PATH, AUDIENCES_PATH, DRAFT_PATH } from "./constants.ts";
import { IcpForm } from "./icp-form.tsx";

type Props = {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
type Api = Awaited<ReturnType<typeof serverApi>>;

export default async function IcpScreen({ params, searchParams }: Props) {
  const { workspace } = await params;
  const chosen = (await searchParams)[AUDIENCE_PARAM];
  const t = await getTranslations("icp.screen");
  const api = await serverApi();
  const path = { workspaceId: workspace };
  const { audiences, limits } = await data(api.GET(AUDIENCES_PATH, { params: { path } }));
  const icpId = typeof chosen === "string" && chosen !== "" ? chosen : undefined;
  const { icp, criteria } = await read(api, workspace, icpId);
  const shown = audiences.find((audience) => audience.id === icp.id);
  const isDefault = shown?.isDefault === true;
  const me = await data(api.GET("/v1/me"));
  const role = me.memberships.find(
    ({ workspaceId, slug }) => workspaceId === workspace || slug === workspace,
  )?.role;
  const owner = shown === undefined ? null : audienceOwner(shown);
  const writable =
    ICP_MANAGE_ROLES.some((manager) => manager === role) ||
    (owner !== null && owner === me.user.id);
  // The default's draft without an id, as before audiences; another's by its id.
  const query = isDefault ? {} : { query: { icpId: icp.id } };
  const draft = await data(api.GET(DRAFT_PATH, { params: { path, ...query } }));
  return (
    <>
      <title>{t("title")}</title>
      <IcpForm
        key={icp.id}
        workspace={workspace}
        audiences={audiences}
        limits={limits}
        icp={icp}
        isDefault={isDefault}
        writable={writable}
        criteria={criteria}
        draft={draft}
      />
    </>
  );
}

/** The audience and its criteria: without an id, the default's, through the ICP's own routes. */
async function read(api: Api, workspaceId: string, icpId: string | undefined) {
  if (icpId === undefined) {
    const request = { params: { path: { workspaceId } } };
    const icp = await data(api.GET("/v1/workspaces/{workspaceId}/icp", request));
    const { criteria } = await data(api.GET("/v1/workspaces/{workspaceId}/icp/criteria", request));
    return { icp, criteria };
  }
  const request = { params: { path: { workspaceId, icpId } } };
  const icp = await data(api.GET(AUDIENCE_PATH, request));
  const { criteria } = await data(api.GET(`${AUDIENCE_PATH}/criteria`, request));
  return { icp, criteria };
}
