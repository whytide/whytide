// The public interface of @whytide/ui (docs/architecture.md §4.1): the components and the provider of
// their text, client components all (hence the directive). The styles are the stylesheets
// @whytide/ui/theme.css and components.css; the theme's cookie is @whytide/ui/theme, the icons
// @whytide/ui/icons, both for server components too; @whytide/ui/gallery is for development.
"use client";

export { Avatar } from "./components/avatar.tsx";
export { Badge, type BadgeTone, type Tier } from "./components/badge.tsx";
export {
  Button,
  ButtonLink,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from "./components/button.tsx";
export { Card } from "./components/card.tsx";
export { Checkbox, type CheckboxProps } from "./components/checkbox.tsx";
export { ChipInput, type ChipInputProps } from "./components/chip-input.tsx";
export { CopyButton } from "./components/copy-button.tsx";
export {
  type Column,
  DataTable,
  type DataTableProps,
  type TablePager,
  type TableSort,
} from "./components/data-table.tsx";
export { Dialog } from "./components/dialog.tsx";
export { EmptyState } from "./components/empty-state.tsx";
export { ErrorState } from "./components/error-state.tsx";
export { Kbd } from "./components/kbd.tsx";
export { Link } from "./components/link.tsx";
export { LoadingState } from "./components/loading-state.tsx";
export { Logo, LogoMark } from "./components/logo.tsx";
export { Menu, MenuItem } from "./components/menu.tsx";
export { Meter, type MeterSegment, type MeterTone } from "./components/meter.tsx";
export { PageHeader } from "./components/page-header.tsx";
export { PublicPage } from "./components/public-page.tsx";
export { SaveBar } from "./components/save-bar.tsx";
export { Select, type SelectOption, type SelectProps } from "./components/select.tsx";
export { Skeleton } from "./components/skeleton.tsx";
export { StatCard } from "./components/stat-card.tsx";
export { Switch } from "./components/switch.tsx";
export { TextArea, type TextAreaProps } from "./components/text-area.tsx";
export { TextField, type TextFieldProps } from "./components/text-field.tsx";
export { ThemeToggle } from "./components/theme-toggle.tsx";
export { Toast } from "./components/toast.tsx";
export { Tooltip } from "./components/tooltip.tsx";
export {
  type TranslateFn,
  TranslationsProvider,
  useErrorText,
  useKeyText,
} from "./translations.tsx";
