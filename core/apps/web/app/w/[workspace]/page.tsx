// The workspace's own address, where sign-in lands: a greeting, and the navigation's entries as the
// steps of the tester's day, each a card that opens its screen.
import { PageHeader } from "@whytide/ui";
import { ArrowRight } from "@whytide/ui/icons";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { data, serverApi } from "../../../src/api/server.ts";
import { navigation } from "../../../src/shell/nav.generated.ts";

type Props = { params: Promise<{ workspace: string }> };

export default async function WorkspaceHome({ params }: Props) {
  const { workspace } = await params;
  const me = await data((await serverApi()).GET("/v1/me"));
  const own = me.memberships.find((m) => workspace === m.slug || workspace === m.workspaceId);
  const t = await getTranslations("web.home");
  return (
    <>
      <PageHeader title={t("title", { workspace: own?.name ?? "" })} description={t("body")} />
      <Steps
        workspace={workspace}
        label={await getTranslations()}
        step={(number) => t("step", { number })}
      />
    </>
  );
}

/** The labels' keys are literals in the nav.ts files, where the message-key check reads them. */
function Steps(props: {
  workspace: string;
  label: (key: string) => string;
  step: (number: number) => string;
}) {
  const { workspace, label, step } = props;
  const entries = navigation.flatMap((group) => group.entries);
  return (
    <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map((entry, index) => (
        <li key={entry.segment}>
          <Link
            href={`/w/${workspace}/${entry.segment}`}
            className="group flex h-full items-center gap-4 rounded-xl border border-line bg-surface p-4 shadow-xs transition duration-150 hover:-translate-y-0.5 hover:border-line-strong/40 hover:shadow-md"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink ring-1 ring-accent/15 ring-inset">
              <entry.icon aria-hidden="true" className="size-5" />
            </span>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-xs font-medium text-ink-muted">{step(index + 1)}</span>
              <span className="truncate font-semibold text-ink">{label(entry.labelKey)}</span>
            </span>
            <ArrowRight
              aria-hidden="true"
              className="size-4 shrink-0 text-ink-muted transition group-hover:translate-x-0.5 group-hover:text-accent-ink rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
            />
          </Link>
        </li>
      ))}
    </ol>
  );
}
