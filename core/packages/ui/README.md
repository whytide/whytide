# @whytide/ui

Shared components, the theme, the icons and the shared messages (Save, Cancel) every screen uses, so that a button, a badge or an error looks the same in every module ([architecture §4.1](../../../docs/architecture.md#41-workspace-layout)): Tailwind CSS 4 classes on the theme of `theme.css`, every string a key in a message file, logical properties only, in class names too ([coding §4](../../../docs/rules/coding.md#4-inside-a-module)).

| Command | Does |
|---|---|
| `pnpm -F ui test` | `tests/*.spec.ts` in Playwright's Chromium, headless |
| `pnpm -F ui lint`, `typecheck`, `build` | the structural lint, stylesheets included; `tsc -b` |
| `pnpm -F platform messages:check` | the message keys, this package's among them |

## Using it

A host's one stylesheet imports, after `@import "tailwindcss"`, `@whytide/ui/theme.css` and `components.css`, with an `@source` line for this package's `components/` and one for every module's `ui/` (the web's `app/globals.css`); it renders `<html data-theme>` from the theme cookie (`@whytide/ui/theme`: `THEME_COOKIE`, `themeOf`, `themeAttribute`) and wraps its tree in `TranslationsProvider translate={t}`, where `t` translates a whole key and has `t.has(key)`: in the web host, next-intl's `useTranslations()` without a namespace, called in a client component. The package root is a client module (`"use client"`): a server component may render the components but not hand them a function such as `onRetry`. A module imports the components from `@whytide/ui` and passes the text it translated itself (`title`, `message`, `children`).

## Theme

`theme.css` is Tailwind's `@theme`, so `bg-surface` or `text-ink-muted` exist:
- colours: the surfaces `canvas`, `surface`, `raised`, `muted`, `hover`; the lines `line`, `line-strong`; the text `ink`, `ink-muted`, `ink-subtle`; the accent `accent` (with `-hover`, `on-accent`, `accent-ink`, `accent-soft`) and `focus`; the brand's gradient `tide-start`, `tide-mid`, `tide-end`; `danger` and `success`; the tiers' `hot`, `warm` and `cool`, each `-ink`, `-soft`, `-dot`. Every text colour is WCAG AA on every surface;
- Inter, `text-2xs`, the shadows `xs` to `lg`, and the motion `animate-pop`, `rise`, `fade`, `drawer`, `shimmer`, 150 to 200 ms, all off under `prefers-reduced-motion`.

Each colour is `light-dark(light, dark)`: the system's choice, or `data-theme="light"` or `"dark"` on `<html>`, set from the cookie `whytide_theme` that `ThemeToggle` writes, or on any element below it (the sign-in page's dark panel). The `dark:` variant follows the same. A host compiles for browsers with a native `light-dark()` (the web's `browserslist`): for older targets Lightning CSS turns it into variables set on `:root`, and a `data-theme` below `<html>` stops working.

`components.css` holds the public classes, the few a module may write in its own markup: `wt-link`, `wt-spinner`, `wt-loading-state`, `wt-visually-hidden`, `wt-field` (with `__control`, `__hint`, `__error`) and `wt-error-state`. Every other style is a Tailwind class in its component. Class names and stylesheets use logical properties only: `pnpm lint` fails on `ml-2` or `margin-left` ([tools/lint](../../../tools/lint/README.md)).

Icons are Lucide's, from `@whytide/ui/icons` (`import { Users } from "@whytide/ui/icons"`), which a server component imports too; a module never lists `lucide-react` itself. An icon beside its words takes `aria-hidden="true"`.

## Components

| Component | Props | States | Keyboard and ARIA |
|---|---|---|---|
| `PageHeader` | `title`, `description`, `leading` (an `Avatar`, say), `meta` (a row of facts), `actions` | title; with a description and actions; with a leading avatar and facts | an `h1`, which breaks inside a word sooner than widen the page (a LinkedIn URL as a title, say) |
| `Button` | `variant` (`primary`, `secondary`, `danger`, `ghost`), `size` (`sm`, `md`), `loading`, the native props but `className` | each variant; small; loading; pressed | a native `button`, `type="button"` by default; loading sets `aria-busy` and `aria-disabled`, ignores the click and keeps the focus; a secondary one with `aria-pressed` shows pressed, in the accent |
| `ButtonLink` | `variant`, `size`, the native props of `a` but `className` | | a native `a` that looks like a button |
| `Link` | the native props of `a` but `className` | | a native `a` |
| `Badge` | `tier` (`hot`, `warm`, `cool`), or a status as `children` with a `tone` (`neutral`, `accent`, `success`, `warning`, `danger`) | tier; status in each tone | the tier in words with its icon (a flame, a sun, a snowflake), a status in its words, never colour alone |
| `Card` | `title`, `level` (2, or 3), `description`, `actions`, `children` | with a heading and a description | a `section` named by its heading |
| `StatCard` | `label`, `value` (formatted with `Intl` by the module), `hint` | | a `dl`; the value in tabular digits |
| `Skeleton` | `lines` (3 by default), `shape` (`lines`, or `table`: as many rows) | lines; table | hidden from assistive technology: a `LoadingState` beside it speaks |
| `Meter` | `value` and `tone` (`accent`, `hot`, `warm`, `cool`, `muted`, `danger`), or `segments` (`{ value, tone }[]`, side by side); `max` (100 by default); `size` (`sm`, `md`) | a share in each tone; none; segments | an SVG, whose widths are attributes, since the content security policy refuses a `style`; a value above 0 shows at 1% at least; hidden: the number stands in text beside it |
| `Avatar` | `name`, `size` (`sm`, `md`, `lg`), `square` (a workspace) | three sizes; square | hidden: the name stands in text beside it |
| `Kbd` | the key's name as `children` | | a `kbd` |
| `Tooltip` | `content` (the hint's words), the trigger as `children` (a `Badge`, say) | hidden; shown | the trigger takes the focus (`tabIndex` 0) and is described by the hint (`role="tooltip"`), shown while the trigger is hovered or focused, the pointer free to reach it; Escape hides it wherever the focus is, a hint the pointer opened too, until the pointer or the focus leaves |
| `Switch` | the native props of `input` but `className`, `type` and `role` | on; off; disabled | a native checkbox with `role="switch"`: Space flips it; named by a wrapping `label` or `aria-label`; the change applies at once, so a form's Save is not needed |
| `SaveBar` | `dirty`, `note` (a line before the actions), the actions as `children` | saved; with changes | a form's last row: with changes it stays at the bottom of the screen (`sticky`) and says `ui.form.unsaved`; the Save inside is the form's submit button |
| `Menu`, `MenuItem` | `trigger`, `block` (as wide as its place), the panel as `children`; `MenuItem` the native props of `button` but `className` | closed; open | a `button` with a popover panel (`popover="auto"`): Escape and a click outside close it, the focus returns to the button; a disclosure, not an ARIA menu |
| `ThemeToggle` | | system, light, dark | a `fieldset` of three radios (`ui.theme.*`); the arrows move the choice, which applies at once and is kept in the cookie |
| `Logo`, `LogoMark` | `size` (`sm`, `md`, `lg`) for the mark | | the mark is hidden; `Logo` writes `ui.brand.name` |
| `PublicPage` | `title`, `description`, `icon` (an element), `panel`, `children` | with and without the brand's panel | the layout of the pages outside the workspaces (sign-in, not found): a `main` with the one `h1`; not in the gallery |
| `EmptyState` | `message` (default `ui.state.empty`), `action` | alone; with an action | |
| `ErrorState` | `module`, `code`, `onRetry` | with and without retry | `role="alert"` |
| `LoadingState` | | | `role="status"`, announced |
| `Toast` | `message` | | `role="status"`, rendered while empty, so that a message is announced; its owner clears it |
| `CopyButton` | `value` | | `navigator.clipboard` (a secure context), then `ui.state.copied`, or the error, in a `Toast` for two seconds |
| `PriceTag` | `credits` (credits per unit, a decimal string as the prices route answers it), `unit` (a word the module translated), `next` (`{ credits, effectiveFrom }`: a coming change, from an instant) | a price; free; with a coming change | text: `ui.price.per_unit` ("1 credit per lookup"), `ui.price.free` for 0, `ui.price.next` ("From Dec 1, 2026: 1.5 credits per lookup"); the translator formats the numbers, four decimals at most as on the credits screens, and the date, in the reader's locale |
| `ReorderableList` | `items` (`{ key, name, content }[]`: `name` the item's name the module translated, "Step 2"; `content` what the module renders), `onMove(from, to)`, `onRemove(index)` (with it, each item has Remove) | in order; moved; one removed | an `ol`; each item's Move up, Move down and Remove buttons are named by `ui.list.move_up`, `ui.list.move_down` and `ui.list.remove` with the item's name, the end ones `aria-disabled` so that the focus can stay on them. After a move the focus stays on the moved item's button and a polite live region says `ui.list.moved` ("Step 2 moved to position 1 of 3"); after a Remove the focus goes to the Remove now in its place, the one before it for the last. No drag and drop |

Every control shows the theme's focus ring on `:focus-visible`. `tests/list.spec.ts` proves `ReorderableList` by keyboard, its focus and its live region; `tests/gallery.spec.ts` shows `PriceTag` in English's and German's formats (`openGallery(page, messages, locale)`).

## Form components

`TextField`, `TextArea`, `Select`, `NumberField`, `ChipInput` and `Checkbox` share one frame: `label`, `hint` and `error`, words the module translated (the error from the API's machine code), and an optional `id` (React's `useId` otherwise). The label sits above the control (after the box of a `Checkbox`), the hint and the error under it; the control is described by both (`aria-describedby`) and is `aria-invalid` while it has an error. The form's state and validation stay with the module.

| Component | Props besides the frame | Keyboard and ARIA |
|---|---|---|
| `TextField` | the native props of `input` but `className`; `type` text, email, url, search, tel or password | a native `input` |
| `TextArea` | the native props of `textarea` but `className`; with `maxLength`, a counter (`ui.field.counter`) | a native `textarea`, which refuses a character past `maxLength`, typed or pasted; the counter is part of its description |
| `Select` | `options` (`{ value, label }`), the native props of `select` but `className` and `multiple` | a native `select`; several values from a list: `ChipInput` with `options` |
| `NumberField` | `value` (a whole number, or null) and `onChange(value)`, `min`, `max`, `step` (1 unless given), `unit` (a word the module translated, shown after the box) | a text box with `role="spinbutton"`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow` and, with a unit, `aria-valuetext` (`ui.field.number_unit`, "3 business days"). Arrow Up and Down change the value by `step`, Page Up and Down by ten steps, Home and End go to `min` and `max`, never past them, each change passed to `onChange` at once. Typed text stays as typed until the field loses the focus, or Enter; then a whole number within the bounds is passed, and anything else passes null, the text staying beside the module's error. Whole numbers only |
| `ChipInput` | `value` or `defaultValue` (`string[]`), `onChange(values)`, `options` for a closed list, `name`, `disabled` | Without `options`, free text: Enter adds the text, and the placeholder says so (`ui.field.placeholder_text`). With `options`, a combobox (placeholder `ui.field.placeholder_options`): a focus, by Tab or a click, opens the list of the options not chosen yet, in their order, as does a click into the focused input; typing narrows it to the labels holding the text, those that start with it first. The list scrolls; the arrows move the active option and keep it in view; Enter or a click picks it, and the list stays open without it. Escape or leaving the field closes it, an arrow opens it again; with every option chosen, nothing opens. Enter with no text and no active option submits the form. The chips are a list named by the label; Tab reaches each chip's remove button (`ui.field.remove`), after which the focus returns to the input. With `name`, each value is posted as a hidden input. |
| `Checkbox` | the native props of `input` but `className` and `type` | a native checkbox; Space ticks it. A whole number is a `NumberField` |

Country names come from `Intl.DisplayNames` in the user's locale, as the gallery's do, never from a message. `tests/forms.spec.ts` proves `NumberField`'s keys, its typed text, its bounds and the module's error.

## Messages

`messages/en.json`: the shared words (`ui.action.*`, `ui.state.*`, `ui.role.*`, `ui.tier.*`), the table's (`ui.table.*`), the form fields' (`ui.field.*`), the reorderable list's (`ui.list.*`), the price tag's (`ui.price.*`, whose ICU skeleton `::.####` shows four decimals at most) and the gallery's own (`ui.gallery.*`). The components read them through `useTranslations(namespace)` of `translations.tsx`, named and shaped like next-intl's hook so that the message-key check reads the keys; modules use next-intl's. `ErrorState` shows `<module>.errors.<code>`, else `platform.error.generic`, the contract of the platform's `translateError`: `useErrorText` builds that key at run time on purpose, as the platform does, and the check proves that every code a module registers has its message; a screen that shows a code in its own place, a table cell, calls `useErrorText(module, code)` itself. `useKeyText()`, from the package root, translates a key that arrives as data, a lead's why bullet `{ key, params }` (alpha-p6-030), or gives `undefined` when the bundle has no such key: built at run time on purpose too, since the check reads only literal keys in a screen; the module that stores the key owns its message.

## The gallery

`dev/gallery.tsx`, exported as `@whytide/ui/gallery` for development only: every component in every state, one section each, named after the component. The web host mounts it at `/dev/ui` (alpha-p2-040, upcoming). A new component adds its section, its keys and its assertions.

## Tests

`tests/gallery.spec.ts`, on Playwright's runner: the states; every word on the page a key (the gallery rendered with each key as its own text); `ErrorState` translating `insufficient_credits`, whose text is the test's fixture since no module owns that code yet; `CopyButton` and `Menu` by keyboard; axe with no serious or critical violation, no rule disabled, in the light and the dark theme. `tests/forms.spec.ts`: the form fields in their states, `Checkbox` by keyboard, the counter and the limit of `TextArea`, `ChipInput` by keyboard, its list on a focus, after a pick and with every option chosen, a long list keeping its active option in view, axe with a list open after a focus; its locale is `en-US`, as the gallery names countries in the browser's language. `openGallery(page, messages)` of `tests/gallery-page.ts` is the harness a spec reuses: esbuild bundles `tests/gallery-entry.tsx` in memory, Tailwind compiles `tests/gallery.css` as a host's stylesheet would, and the page opens at `http://127.0.0.1/gallery`, answered by the test's own route: a secure context, no server, every other request aborted.

The browser is Playwright's Chromium for `@playwright/test` 1.64.1 (revision 1248), headless, no `channel`; install it once with `pnpm -F ui exec playwright install --only-shell chromium`, as the GitLab job does. `axe-core` (MPL-2.0) stays in the tests: nothing under `dev/` or the components imports it.

## DataTable

`DataTable` puts the rows a module holds in a native `<table>`, and sorts and pages them in the browser; loading them is the module's. In the controlled mode the module sorts and pages them itself, on its server.

| Prop | Is |
|---|---|
| `caption` | the table's name for assistive technology, in a visually hidden caption |
| `columns` | `{ id, header, cell, sortValue?, sortable? }[]`: `header` is text the module translated from its own key (`t("leads.columns.name")`), never a literal; `cell(row)` renders the cell; `sortValue(row)`, a string or a number, makes the column sortable; `sortable` does in the controlled mode |
| `rows` | the rows, each with an `id` |
| `rowHref` | the page a row opens: its first cell becomes the link, and a click anywhere on the row follows it |
| `defaultSort` | `{ column, direction }`, the direction `ascending` or `descending` |
| `pageSize` | 20 unless given |
| `empty` | shown instead of the table when there is no row: the shared `EmptyState` unless given |
| `sort`, `onSortChange` | the controlled mode: the order the rows arrive in, which the table shows (`aria-sort`) and never applies; a `sortable` header calls `onSortChange` with the next sort, as the browser mode would sort |
| `pager` | `{ onPrevious?, onNext? }`, paging by cursor: the rows are one page, the pager has Previous and Next, each `aria-disabled` without its handler, and no page count; `pageSize` is unused |

A sortable header is a `button`: the first press sorts ascending, the next flips, and the sorted column's `th` carries `aria-sort`; the caption says that the header buttons sort. A row's first cell is its row header and holds its link, so Tab goes from row to row and Enter opens one. The pager is a `nav` with Previous and Next, `aria-disabled` at either end so the focus stays, and the page in a `status` region. Strings sort by `Intl.Collator` in the default locale, digits as numbers (Lead 2 before Lead 10).

## Dialog

`Dialog` is a modal on the native `<dialog>`, its props `DialogProps` from the package root: `open` (the module's state), `onClose` (Escape or Cancel; the module sets `open` to false), `title` (the heading that names it), the body as `children`, and `actions`, the buttons after its own Cancel (`ui.action.cancel`). While it is open the page behind it is inert and holds still: the document's overflow is hidden, and the value found there comes back when it closes. Tab cycles through its controls, past the hidden and the disabled ones; the first control takes the focus, Cancel when the body has none; Escape closes it. However it closes, by Escape, Cancel, the module's action or the module unmounting it while open, the page scrolls again and the focus returns to the control that opened it.

`tests/table-and-dialog.spec.ts` proves both: the entries and their states, sorting, paging and a row link by keyboard, the controlled mode, the dialog's focus (back on its opener after Escape, Cancel, the action and an unmount while open; Tab past hidden and disabled controls), the scroll lock, axe with the dialog open.
