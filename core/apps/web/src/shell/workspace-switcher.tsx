// The sidebar's workspace (docs/screens.md "The shell"): its name and the member's role in it, and,
// for a member of more than one, a menu of them all (GET /v1/me), each a link to its home.
import { Avatar, Menu } from "@whytide/ui";
import { Check } from "@whytide/ui/icons";
import { getTranslations } from "next-intl/server";

type Membership = {
  workspaceId: string;
  slug: string;
  name: string;
  role: "Owner" | "Admin" | "Member";
};
type Props = { current: Membership; memberships: readonly Membership[] };

export async function WorkspaceSwitcher({ current, memberships }: Props) {
  const t = await getTranslations("web.shell");
  const role = await getTranslations("ui.role");
  const roles = { Owner: role("owner"), Admin: role("admin"), Member: role("member") };
  const face = (
    <>
      <Avatar name={current.name} square />
      <span className="grid min-w-0">
        <span className="truncate font-semibold text-ink">{current.name}</span>
        <span className="truncate text-xs font-normal text-ink-muted">{roles[current.role]}</span>
      </span>
    </>
  );
  if (memberships.length < 2) return <div className="flex items-center gap-2 p-1.5">{face}</div>;
  return (
    <Menu block trigger={face}>
      <p className="px-2.5 pt-1.5 pb-1 text-2xs font-semibold tracking-wider text-ink-muted uppercase">
        {t("workspaces")}
      </p>
      {memberships.map((membership) => (
        <a
          key={membership.workspaceId}
          href={`/w/${membership.slug}`}
          aria-current={membership.workspaceId === current.workspaceId ? "page" : undefined}
          className="group flex h-10 items-center gap-2.5 rounded-lg px-2.5 text-ink transition-colors hover:bg-hover"
        >
          <Avatar name={membership.name} size="sm" square />
          <span className="min-w-0 flex-1 truncate">{membership.name}</span>
          <Check
            aria-hidden="true"
            className="hidden size-4 text-accent-ink group-aria-[current=page]:block"
          />
        </a>
      ))}
    </Menu>
  );
}
