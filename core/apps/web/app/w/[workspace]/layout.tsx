// The shell of a workspace (docs/screens.md "The shell"): the workspace from the URL among the
// member's own (GET /v1/me); the sidebar, with the logo, the workspace and the navigation that `pnpm
// web:routes` assembled from the modules' ui/nav.ts, a drawer under 1024 px; the header, with the
// trail, the slots of the credit balance (alpha-p6-050) and of the account menu (identity's), and the
// feedback link. With no session, /sign-in, `next` the page asked for (proxy.ts); another's
// workspace is not found.

import { Logo } from "@whytide/ui";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { data, serverApi } from "../../../src/api/server.ts";
import { Drawer } from "../../../src/shell/drawer.tsx";
import { FeedbackLink } from "../../../src/shell/feedback-link.tsx";
import { Navigation, Trail } from "../../../src/shell/navigation.tsx";
import { slots } from "../../../src/shell/slots.generated.tsx";
import { WorkspaceSwitcher } from "../../../src/shell/workspace-switcher.tsx";

type Props = { children: ReactNode; params: Promise<{ workspace: string }> };

export default async function WorkspaceLayout({ children, params }: Props) {
  const { workspace } = await params;
  const answer = await (await serverApi()).GET("/v1/me");
  if (answer.response.status === 401) {
    // proxy.ts sets the header on every page but a prefetch, where it is the client's: a page of
    // this workspace only.
    const home = `/w/${workspace}`;
    const asked = (await headers()).get("x-whytide-path") ?? "";
    const inside = asked.startsWith(home) && /^(?:[/?]|$)/.test(asked.slice(home.length));
    redirect(`/sign-in?next=${encodeURIComponent(inside ? asked : home)}`);
  }
  const me = await data(Promise.resolve(answer));
  const own = me.memberships.find((m) => workspace === m.slug || workspace === m.workspaceId);
  if (own === undefined) notFound();
  const t = await getTranslations("web.shell");
  const Balance = slots.balance;
  const Account = slots["sign-out"];
  const sidebar = (
    <>
      <div className="flex h-9 items-center px-1.5">
        <Logo />
      </div>
      <WorkspaceSwitcher current={own} memberships={me.memberships} />
      <Navigation workspace={workspace} />
    </>
  );
  return (
    <div className="lg:grid lg:h-dvh lg:grid-cols-[15rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-raised px-3 py-2 font-medium shadow-lg focus:not-sr-only focus:fixed focus:start-3 focus:top-3"
      >
        {t("skip")}
      </a>
      <div className="hidden flex-col gap-5 overflow-y-auto p-3 lg:flex">{sidebar}</div>
      {/* Its scroll keeps a field brought into view clear of a screen's sticky save bar. */}
      <div className="flex min-h-dvh min-w-0 flex-col bg-surface lg:m-2 lg:ms-0 lg:min-h-0 lg:scroll-pb-24 lg:overflow-y-auto lg:rounded-2xl lg:shadow-sm lg:ring-1 lg:ring-line">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/80 px-3 backdrop-blur-md sm:px-4 lg:px-6">
          <Drawer label={t("navigation")} open={t("open_navigation")} close={t("close_navigation")}>
            {sidebar}
          </Drawer>
          <Trail workspace={workspace} name={own.name} />
          <div className="ms-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <div
              data-slot="balance"
              className="[&_a]:inline-flex [&_a]:h-8 [&_a]:items-center [&_a]:gap-1.5 [&_a]:rounded-full [&_a]:px-3 [&_a]:text-xs [&_a]:text-ink [&_a]:tabular-nums [&_a]:no-underline [&_a]:ring-1 [&_a]:ring-line [&_a]:hover:bg-hover"
            >
              {Balance && <Balance email={me.user.email} workspaceId={own.workspaceId} />}
            </div>
            <FeedbackLink url={me.feedbackUrl} />
            <div data-slot="sign-out">
              {Account && <Account email={me.user.email} workspaceId={own.workspaceId} />}
            </div>
          </div>
        </header>
        <main
          id="main"
          className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
