// The LinkedIn screen (README.md "Screen"), a server component: the title, the header, the
// provider's failed return (`?connect=failed`; `?connect=done` needs nothing, the account shows its
// status), and the signed-in user's account, which accounts.tsx loads in the browser, with its states.
import { PageHeader } from "@whytide/ui";
import { CircleAlert } from "@whytide/ui/icons";
import { getTranslations } from "next-intl/server";
import { Accounts } from "./accounts.tsx";

type Props = {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LinkedinAccounts({ params, searchParams }: Props) {
  const { workspace } = await params;
  const { connect } = await searchParams;
  const t = await getTranslations("linkedin");
  return (
    <>
      {/* The document's title too (axe's document-title): React hoists it into the head. */}
      <title>{t("page.title")}</title>
      <PageHeader title={t("page.title")} description={t("page.description")} />
      {connect === "failed" ? (
        <p
          role="alert"
          className="mb-6 flex items-start gap-2.5 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-danger-ink"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("connect.failed")}
        </p>
      ) : null}
      <Accounts workspaceId={workspace} />
    </>
  );
}
