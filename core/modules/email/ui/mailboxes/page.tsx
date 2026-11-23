// The mailboxes screen (README.md "Screen"), a server component: the title, the header, and the
// mailboxes, which mailboxes.tsx loads in the browser.
import { PageHeader } from "@whytide/ui";
import { getTranslations } from "next-intl/server";
import { Mailboxes } from "./mailboxes.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function EmailMailboxes({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("email.mailboxes");
  return (
    <>
      {/* The document's title too (axe's document-title): React hoists it into the head. */}
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={t("description")} />
      <Mailboxes workspaceId={workspace} />
    </>
  );
}
