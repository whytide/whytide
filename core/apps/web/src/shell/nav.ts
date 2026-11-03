// The navigation's groups in the order of the tester's day, each with its label's key. A module's
// ui/nav.ts names one as `group`, and its entry's icon by name; `pnpm web:routes` checks them and
// writes nav.generated.ts, which imports the icons.
import type { LucideIcon } from "@whytide/ui/icons";

export const GROUPS = {
  company: "web.nav.company",
  icp: "web.nav.icp",
  sources: "web.nav.sources",
  import: "web.nav.import",
  leads: "web.nav.leads",
  linkedin: "web.nav.linkedin",
} as const;

/** The icon of an entry whose nav.ts names none. */
export const DEFAULT_ICON = "CircleDot";

export type Group = keyof typeof GROUPS;
/** A group of the navigation: its entries' icons by name in web:routes, as components in the shell. */
export type NavGroup<Icon = LucideIcon> = {
  readonly group: Group;
  readonly labelKey: string;
  readonly entries: readonly {
    readonly labelKey: string;
    readonly segment: string;
    readonly icon: Icon;
  }[];
};
