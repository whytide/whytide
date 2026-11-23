// The members screen (README.md "Members"), a server component: the title, the header, and the
// members, which members.tsx loads in the browser.
import { PageHeader } from "@whytide/ui";
import { getTranslations } from "next-intl/server";
import { Members } from "./members.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function TenancyMembers({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("tenancy.members");
  return (
    <>
      {/* The document's title too (axe's document-title): React hoists it into the head. */}
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={t("description")} />
      <Members workspaceId={workspace} />
    </>
  );
}
