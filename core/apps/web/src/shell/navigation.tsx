// The shell's navigation and the trail in its header (docs/screens.md "The shell"), client components
// for the address: the current entry marked. The labels' keys are literals in the modules' nav.ts
// files, where the message-key check reads them, so they come through `label`, a translator prop.
"use client";

import { ChevronRight } from "@whytide/ui/icons";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { navigation } from "./nav.generated.ts";

type Label = (key: string) => string;

/** The entry of the navigation an address is in, by its segment: /w/{workspace}/{segment}/… */
function entryAt(path: string) {
  const segment = path.split("/")[3];
  return navigation.flatMap((group) => group.entries).find((entry) => entry.segment === segment);
}

export function Navigation({ workspace }: { workspace: string }) {
  const label = useTranslations();
  return <Groups workspace={workspace} label={label} path={usePathname()} />;
}

function Groups({ workspace, label, path }: { workspace: string; label: Label; path: string }) {
  const t = useTranslations("web.shell");
  const id = useId();
  const current = entryAt(path);
  return (
    <nav aria-label={t("navigation")} className="grid gap-5">
      {navigation.map((group) => (
        <section key={group.group} className="grid gap-1">
          <h2
            id={`${id}-${group.group}`}
            className="px-2.5 text-2xs font-semibold tracking-wider text-ink-muted uppercase"
          >
            {label(group.labelKey)}
          </h2>
          <ul aria-labelledby={`${id}-${group.group}`} className="grid gap-0.5">
            {group.entries.map((entry) => (
              <li key={entry.segment}>
                <Link
                  href={`/w/${workspace}/${entry.segment}`}
                  aria-current={entry === current ? "page" : undefined}
                  className="group flex h-8 items-center gap-2.5 rounded-lg px-2.5 font-medium text-ink-muted transition-colors hover:bg-hover hover:text-ink aria-[current=page]:bg-surface aria-[current=page]:text-ink aria-[current=page]:shadow-xs aria-[current=page]:ring-1 aria-[current=page]:ring-line"
                >
                  <entry.icon
                    aria-hidden="true"
                    className="size-4 shrink-0 group-aria-[current=page]:text-accent-ink"
                  />
                  <span className="truncate">{label(entry.labelKey)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/**
 * The header's trail: the workspace, to its home, then the entry the page is in; on a phone, the
 * entry alone, as the drawer holds the workspace.
 */
export function Trail({ workspace, name }: { workspace: string; name: string }) {
  const label = useTranslations();
  return <Crumbs workspace={workspace} name={name} label={label} path={usePathname()} />;
}

function Crumbs(props: { workspace: string; name: string; label: Label; path: string }) {
  const { workspace, name, label, path } = props;
  const current = entryAt(path);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Link
        href={`/w/${workspace}`}
        className={`truncate rounded-md font-semibold text-ink transition-colors hover:text-accent-ink ${current ? "max-sm:hidden" : ""}`}
      >
        {name}
      </Link>
      {current ? (
        <>
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 text-ink-muted max-sm:hidden rtl:-scale-x-100"
          />
          <span className="truncate text-ink-muted max-sm:font-semibold max-sm:text-ink">
            {label(current.labelKey)}
          </span>
        </>
      ) : null}
    </div>
  );
}
