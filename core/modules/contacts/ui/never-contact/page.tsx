// The never-contact screen (README.md "Screens"), a server component: the title and the header;
// list.tsx holds the add form and the list, which it reads in the browser, with its states. React
// puts the <title> in the document's head, as on the lead list.
import { PageHeader } from "@whytide/ui";
import { getTranslations } from "next-intl/server";
import { NeverContactList } from "./list.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function NeverContact({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("contacts.never_contact");
  return (
    <>
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={t("description")} />
      <NeverContactList workspace={workspace} />
    </>
  );
}
