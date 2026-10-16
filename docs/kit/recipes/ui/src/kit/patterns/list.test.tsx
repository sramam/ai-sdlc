import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { DataState, type Loadable } from "./data-state";
import { DataTable, useListState, type Column, type SearchAdapter } from "./list";
import { EmptyState } from "./empty";

type Unit = { id: string; name: string; rentCents: number };
const units: Unit[] = [
  { id: "u1", name: "Unit 2", rentCents: 125_000 },
  { id: "u2", name: "Unit 10", rentCents: 90_000 },
  { id: "u3", name: "Annex", rentCents: 210_000 },
];
const usd = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);
const columns: Column<Unit>[] = [
  {
    id: "name",
    header: "Name",
    value: (u) => u.name,
    cell: (u) => <a href={`/units/${u.id}`}>{u.name}</a>,
    searchable: true,
  },
  { id: "rent", header: "Rent", value: (u) => u.rentCents, cell: (u) => usd(u.rentCents) },
];

/** An in-memory URL, so the test reads exactly what a browser would put in the address bar. */
function memorySearch(initial = ""): SearchAdapter & { current: () => string } {
  let qs = initial;
  return {
    read: () => new URLSearchParams(qs),
    write: (p) => void (qs = p.toString()),
    current: () => qs,
  };
}

function Units({ url, state }: { url: SearchAdapter; state: Loadable<Unit[]> }) {
  const list = useListState(url);
  return (
    <DataState
      state={state}
      skeleton={<div data-testid="skeleton-rows" />}
      isEmpty={(d) => d.length === 0}
      empty={
        <EmptyState
          title="No units yet"
          why="Units appear once a property is added."
          action={<a href="/properties/new">Add a property</a>}
        />
      }
    >
      {(rows) => (
        <DataTable
          columns={columns}
          rows={rows}
          rowId={(u) => u.id}
          list={list}
          empty={<p>No unit matches “{list.state.q}”.</p>}
        />
      )}
    </DataState>
  );
}

const names = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]!.textContent);

describe("list", () => {
  let url: ReturnType<typeof memorySearch>;
  beforeEach(() => (url = memorySearch()));

  it("sorts on the underlying value, not the formatted text, and puts the sort in the URL", async () => {
    render(<Units url={url} state={{ status: "ready", data: units }} />);
    await userEvent.click(screen.getByRole("button", { name: /rent/i }));
    // $900.00 < $1,250.00 < $2,100.00 — a string sort would put $1,250.00 first
    expect(names()).toEqual(["Unit 10", "Unit 2", "Annex"]);
    expect(url.current()).toBe("sort=rent");
    expect(screen.getByRole("columnheader", { name: /rent/i })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("restores search and sort from the URL (a narrowed list is a link)", () => {
    url = memorySearch("q=unit&sort=-name");
    render(<Units url={url} state={{ status: "ready", data: units }} />);
    expect(names()).toEqual(["Unit 10", "Unit 2"]); // alphanumeric descending: 10 > 2, as a person reads it
    expect(screen.getByRole("searchbox")).toHaveValue("unit");
  });

  it("search narrows, writes q, and says when nothing matches", async () => {
    render(<Units url={url} state={{ status: "ready", data: units }} />);
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(url.current()).toBe("q=zzz");
    expect(screen.getByText("No unit matches “zzz”.")).toBeInTheDocument();
  });

  it("a row opens its record through a real link (keyboard and new-tab work)", () => {
    render(<Units url={url} state={{ status: "ready", data: units }} />);
    expect(screen.getByRole("link", { name: "Annex" })).toHaveAttribute("href", "/units/u3");
  });

  it("the four states: loading, error with retry, empty with its one action", async () => {
    const { rerender } = render(<Units url={url} state={{ status: "loading" }} />);
    expect(screen.getByTestId("skeleton-rows").parentElement).toHaveAttribute("aria-busy", "true");
    let retried = 0;
    rerender(
      <Units
        url={url}
        state={{ status: "error", message: "The server did not answer.", retry: () => retried++ }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retried).toBe(1);
    rerender(<Units url={url} state={{ status: "ready", data: [] }} />);
    expect(screen.getByText("No units yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a property" })).toHaveAttribute(
      "href",
      "/properties/new",
    );
  });
});
