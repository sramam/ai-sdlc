// List: a data table whose question (search, sort, page) lives in the URL, so a
// narrowed list is a link somebody can send. Columns sort on the UNDERLYING
// value (cents, a date), never the formatted text: "$900" sorts after "$1,250".
import { useState, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import {
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Where list state is kept. In TanStack Start: `useSearch` + `navigate({ search, replace: true })`. */
export type SearchAdapter = { read(): URLSearchParams; write(next: URLSearchParams): void };

export const browserSearch: SearchAdapter = {
  read: () => new URLSearchParams(window.location.search),
  write: (next) => {
    const qs = next.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  },
};

export type ListState = { q: string; sort: { id: string; desc: boolean } | null };

export function useListState(adapter: SearchAdapter) {
  const parse = (p: URLSearchParams): ListState => {
    const sort = p.get("sort");
    return {
      q: p.get("q") ?? "",
      sort: sort ? { id: sort.replace(/^-/, ""), desc: sort.startsWith("-") } : null,
    };
  };
  const [state, setState] = useState(() => parse(adapter.read()));
  const update = (next: ListState) => {
    const p = adapter.read();
    if (next.q) p.set("q", next.q);
    else p.delete("q");
    if (next.sort) p.set("sort", `${next.sort.desc ? "-" : ""}${next.sort.id}`);
    else p.delete("sort");
    adapter.write(p);
    setState(next);
  };
  return { state, update };
}

export type Column<T> = {
  id: string;
  header: string;
  /** The underlying value: what sorts and what search matches. */
  value: (row: T) => string | number;
  /** How it is shown. Defaults to the value. */
  cell?: (row: T) => ReactNode;
  searchable?: boolean;
};

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});

export function DataTable<T extends RowData>(props: {
  columns: Column<T>[];
  rows: T[];
  rowId: (row: T) => string;
  list: ReturnType<typeof useListState>;
  /** Filter the loaded rows by `q`. False when the server pages and searches (past a few hundred rows). */
  local?: boolean;
  empty: ReactNode;
}) {
  const { state, update } = props.list;
  const searchable = props.columns.filter((c) => c.searchable);
  const q = state.q.trim().toLowerCase();
  const rows =
    props.local !== false && q
      ? props.rows.filter((r) =>
          searchable.some((c) => String(c.value(r)).toLowerCase().includes(q)),
        )
      : props.rows;

  const columns: ColumnDef<typeof features, T>[] = props.columns.map((c) => ({
    id: c.id,
    header: c.header,
    accessorFn: c.value,
    sortDescFirst: false, // TanStack sorts number columns descending first; one rule for every column
    sortFn:
      typeof (props.rows[0] && c.value(props.rows[0])) === "number" ? "basic" : "alphanumeric",
    cell: (info) => (c.cell ? c.cell(info.row.original) : String(info.getValue())),
  }));
  const sorting: SortingState = state.sort ? [state.sort] : [];
  const table = useTable({
    features,
    data: rows,
    columns,
    getRowId: props.rowId,
    state: { sorting },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      update({ ...state, sort: next[0] ?? null });
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        aria-label="Search"
        placeholder="Search…"
        className="max-w-xs"
        defaultValue={state.q}
        onChange={(e) => update({ ...state, q: e.currentTarget.value })}
      />
      {rows.length === 0 ? (
        props.empty
      ) : (
        <div className="max-h-[70svh] overflow-auto rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((h) => {
                    const dir = h.column.getIsSorted();
                    return (
                      <TableHead
                        key={h.id}
                        aria-sort={
                          dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"
                        }
                      >
                        <button
                          type="button"
                          className="inline-flex items-center gap-1"
                          onClick={h.column.getToggleSortingHandler()}
                        >
                          <table.FlexRender header={h} />
                          {dir === "asc" ? (
                            <ArrowUpIcon className="size-3" />
                          ) : dir === "desc" ? (
                            <ArrowDownIcon className="size-3" />
                          ) : null}
                        </button>
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
