// The LinkedIn screen (README.md "Screen"), a server component: the title, the header, the
// provider's failed return (`?connect=failed`; `?connect=done` needs nothing, the account shows its
// status), the accounts the member sees, their own first and an Owner's teammates' after it, which
// accounts.tsx loads in the browser, with its states, and the workspace's "Stop everything" under
// them (workspace-stop.tsx), which only a holder of linkedin.manage may press: the member's role
// from GET /v1/me (gamma-p6-070).
import { PageHeader } from "@whytide/ui";
import { CircleAlert } from "@whytide/ui/icons";
import { data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { LINKEDIN_MANAGE_ROLES } from "../../domain/controls/constants.ts";
import { Accounts } from "./accounts.tsx";
import { WorkspaceStop } from "./workspace-stop.tsx";

type Props = {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LinkedinAccounts({ params, searchParams }: Props) {
  const { workspace } = await params;
  const { connect } = await searchParams;
  const t = await getTranslations("linkedin");
  const me = await data((await serverApi()).GET("/v1/me"));
  const role = me.memberships.find(
    ({ workspaceId, slug }) => workspaceId === workspace || slug === workspace,
  )?.role;
  const canStop = LINKEDIN_MANAGE_ROLES.some((manager) => manager === role);
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
      <div className="mt-6">
        <WorkspaceStop workspaceId={workspace} canStop={canStop} />
      </div>
    </>
  );
}
