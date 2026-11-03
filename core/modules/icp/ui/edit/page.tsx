// The ICP screen, /w/{workspace}/icp (README "The screen"): a server component that reads the ICP and
// its criteria through the api as the visitor, then hands them to the form, a client component. The
// first read of a workspace creates its empty ICP, as the api does.
import { data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { IcpForm } from "./icp-form.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function IcpScreen({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("icp.screen");
  const api = await serverApi();
  const request = { params: { path: { workspaceId: workspace } } };
  const icp = await data(api.GET("/v1/workspaces/{workspaceId}/icp", request));
  const { criteria } = await data(api.GET("/v1/workspaces/{workspaceId}/icp/criteria", request));
  return (
    <>
      <title>{t("title")}</title>
      <IcpForm workspace={workspace} icp={icp} criteria={criteria} />
    </>
  );
}
