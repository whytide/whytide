import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslations } from "../translations.tsx";
import { buttonClass } from "./button.tsx";
import { cx } from "./cx.ts";
import { EmptyState } from "./empty-state.tsx";

export type TableSort = { column: string; direction: "ascending" | "descending" };

export type Column<Row> = {
  /** Names the column in `defaultSort` and `sort`. */
  id: string;
  /** The header: text the module translated from its own key (`t("leads.columns.name")`). */
  header: string;
  cell: (row: Row) => ReactNode;
  /** Makes the column sortable in the browser: the value its rows are ordered by. */
  sortValue?: (row: Row) => string | number;
  /** Makes the column sortable in the controlled mode, where the module orders the rows. */
  sortable?: boolean;
};

/** Paging by cursor, the module's: Previous and Next call these, each `aria-disabled` without one. */
export type TablePager = { onPrevious?: () => void; onNext?: () => void };

export type DataTableProps<Row> = {
  /** Names the table for assistive technology, in a visually hidden caption. */
  caption: string;
  columns: Column<Row>[];
  rows: Row[];
  /** The page a row opens: the first cell becomes its link, and the whole row clicks through. */
  rowHref?: (row: Row) => string;
  defaultSort?: TableSort;
  /** Rows per page (20 unless given); the pager shows when there is more than one page. */
  pageSize?: number;
  /** Shown instead of the table when there is no row: the shared EmptyState unless given. */
  empty?: ReactNode;
  /**
   * The controlled mode, with `onSortChange`: the sort the rows arrive in, sorted by the module (on
   * the server, say), which the table shows and never applies; a `sortable` header asks for the next.
   */
  sort?: TableSort;
  onSortChange?: (sort: TableSort) => void;
  /** The rows are one page the module loaded: Previous and Next, no page count; `pageSize` is unused. */
  pager?: TablePager;
};

const collator = new Intl.Collator(undefined, { numeric: true });
const compare = (a: string | number, b: string | number) =>
  typeof a === "number" && typeof b === "number" ? a - b : collator.compare(`${a}`, `${b}`);

/**
 * The rows a module holds, in a native table: a sortable column's header is a button (`aria-sort`
 * on the sorted one), each row a link in its first cell, a pager under it. It sorts and pages the
 * rows it is given, or, in the controlled mode (`onSortChange`, `pager`), shows the module's order
 * and page and asks the module for another.
 */
export function DataTable<Row extends { id: string }>(props: DataTableProps<Row>) {
  const { caption, columns, rows, rowHref, pageSize = 20, onSortChange, pager } = props;
  const t = useTranslations("ui.table");
  const [own, setOwn] = useState(props.defaultSort);
  const [page, setPage] = useState(1);
  if (rows.length === 0) return props.empty ?? <EmptyState />;
  const sort = onSortChange ? props.sort : own;
  const isSortable = (column: Column<Row>) =>
    onSortChange ? column.sortable === true : column.sortValue !== undefined;
  const sortValue = onSortChange
    ? undefined
    : columns.find((column) => column.id === sort?.column)?.sortValue;
  const sign = sort?.direction === "descending" ? -1 : 1;
  const ordered = sortValue
    ? rows.toSorted((a, b) => sign * compare(sortValue(a), sortValue(b)))
    : rows;
  const pages = pager ? 1 : Math.ceil(rows.length / pageSize);
  const current = Math.min(page, pages);
  const shown = pager ? ordered : ordered.slice((current - 1) * pageSize, current * pageSize);
  const sortBy = (column: string) => {
    const ascending = sort?.column !== column || sort.direction === "descending";
    const next: TableSort = { column, direction: ascending ? "ascending" : "descending" };
    if (onSortChange) return onSortChange(next);
    setOwn(next);
    setPage(1);
  };
  const sortable = columns.some(isSortable);
  const cell =
    "border-b border-line px-3 py-3 text-start align-middle first:ps-4 last:pe-4 group-last/row:border-b-0";
  return (
    <div className="wt-table overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">{sortable ? t("sortable", { caption }) : caption}</caption>
          <thead className="bg-muted/60">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={sort?.column === column.id ? sort.direction : undefined}
                  className="h-10 whitespace-nowrap border-b border-line px-3 text-start text-xs font-medium text-ink-muted first:ps-4 last:pe-4"
                >
                  {isSortable(column) ? (
                    <button
                      type="button"
                      className="-mx-1.5 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-hover hover:text-ink"
                      onClick={() => sortBy(column.id)}
                    >
                      {column.header}
                      <SortIcon
                        direction={sort?.column === column.id ? sort.direction : undefined}
                      />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr
                key={row.id}
                className={cx(
                  "group/row",
                  rowHref && "relative transition-colors hover:bg-muted/70",
                )}
              >
                {columns.map((column, index) =>
                  index === 0 ? (
                    <th key={column.id} scope="row" className={cx(cell, "font-medium text-ink")}>
                      {rowHref ? (
                        <a
                          className="outline-hidden transition-colors after:absolute after:inset-0 hover:text-accent-ink focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-focus"
                          href={rowHref(row)}
                        >
                          {column.cell(row)}
                        </a>
                      ) : (
                        column.cell(row)
                      )}
                    </th>
                  ) : (
                    <td key={column.id} className={cx(cell, "text-ink-muted tabular-nums")}>
                      {column.cell(row)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager?.onPrevious || pager?.onNext ? (
        <Pager label={t("pages")}>
          <PageButton disabled={!pager.onPrevious} onClick={pager.onPrevious} previous>
            {t("previous")}
          </PageButton>
          <PageButton disabled={!pager.onNext} onClick={pager.onNext}>
            {t("next")}
          </PageButton>
        </Pager>
      ) : !pager && pages > 1 ? (
        <Pager label={t("pages")}>
          <p role="status" className="me-auto text-xs text-ink-muted tabular-nums">
            {t("page", { page: current, pages })}
          </p>
          <PageButton disabled={current === 1} onClick={() => setPage(current - 1)} previous>
            {t("previous")}
          </PageButton>
          <PageButton disabled={current === pages} onClick={() => setPage(current + 1)}>
            {t("next")}
          </PageButton>
        </Pager>
      ) : null}
    </div>
  );
}

function SortIcon({ direction }: { direction?: TableSort["direction"] }) {
  if (direction === "ascending")
    return <ArrowUp aria-hidden="true" className="size-3.5 text-ink" />;
  if (direction === "descending")
    return <ArrowDown aria-hidden="true" className="size-3.5 text-ink" />;
  return <ArrowUpDown aria-hidden="true" className="size-3.5 opacity-60" />;
}

function Pager({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav
      aria-label={label}
      className="flex items-center justify-end gap-2 border-t border-line bg-muted/40 px-4 py-2.5"
    >
      {children}
    </nav>
  );
}

/** `aria-disabled`, not `disabled`, so the focus stays on the button at the first or last page. */
function PageButton(props: {
  disabled: boolean;
  onClick?: () => void;
  previous?: boolean;
  children: ReactNode;
}) {
  const Chevron = props.previous ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      className={buttonClass("secondary", "sm")}
      aria-disabled={props.disabled || undefined}
      onClick={props.disabled ? undefined : props.onClick}
    >
      {props.previous ? <Chevron aria-hidden="true" className="rtl:-scale-x-100" /> : null}
      {props.children}
      {props.previous ? null : <Chevron aria-hidden="true" className="rtl:-scale-x-100" />}
    </button>
  );
}
