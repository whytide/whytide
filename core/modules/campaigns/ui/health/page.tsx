// "Health" (README.md "Screens"), /w/{ws}/health, a server component: the <title> and the header,
// whose line says what the page shows and where each sender is acted on; then its sections, each
// read in the browser from its owning module's routes and loading, failing and retrying on its own,
// so campaigns reads no other module's tables and adds no route. The LinkedIn senders' section is
// senders.tsx; email's mailboxes join as a section of their own beside it in the email phase
// (gamma-p6-085's Open questions), with no change to this one. Read-only: nothing here acts on a
// sender. React puts the <title> in the document's head: the generated route re-exports the page
// alone, so a `metadata` export would not reach it.
import { PageHeader } from "@whytide/ui";
import { getTranslations } from "next-intl/server";
import { Senders } from "./senders.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function HealthPage({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("campaigns.health");
  return (
    <>
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="grid gap-8">
        <Senders workspace={workspace} />
      </div>
    </>
  );
}
