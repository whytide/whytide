// The Invites screen (README.md "Invites"), a server component: the title, the header with how long
// an invite stays open, and the invites, which invites.tsx loads in the browser. The days are the
// list's answer, as the api is configured (README "Settings"), read through the api as the visitor:
// a Member's read is refused (403), and the header then has no description, the list's hint saying
// that only an Owner invites.
import { PageHeader } from "@whytide/ui";
import { serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { INVITES_PATH } from "../../domain/constants.ts";
import { Invites } from "./invites.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function IdentityInvites({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("identity.invites");
  const api = await serverApi();
  const { data } = await api.GET(INVITES_PATH, { params: { path: { workspaceId: workspace } } });
  const description = data === undefined ? undefined : t("description", { days: data.ttlDays });
  return (
    <>
      {/* The document's title too (axe's document-title): React hoists it into the head. */}
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={description} />
      <Invites workspaceId={workspace} />
    </>
  );
}
